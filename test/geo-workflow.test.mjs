import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createGeoChecks } from "../geo-checks.mjs";
import { createGeoPlatforms } from "../geo-platforms.mjs";
import { withCustomProviderTransport } from "../vendor/niubigeo/dist/src/providers/custom-connection.js";

test("GEO evidence survives reload and retest preserves the baseline configuration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yaosight-geo-test-"));
  const configuration = [{ id: "gpt", model: "test-gpt", search: false, routeFingerprint: "route-1" },
    { id: "gemini", model: "test-gemini", search: true, routeFingerprint: "route-2" }];
  const target = "https://example.com/article";
  const prompts = [];
  const platforms = {
    list: () => [{ id: "gpt", label: "GPT", ready: true }, { id: "gemini", label: "Gemini", ready: true, search: true }],
    configuration: (id) => ({ ...configuration.find((item) => item.id === id) }),
    async answer(id, prompt) {
      prompts.push([id, prompt]);
      if (id === "gemini") throw Object.assign(new Error("busy"), { code: "rate_limited" });
      return { text: "Answer", citations: [{ url: target, source: "answer_text_url" }],
        search: { used: false }, rawProviderResponse: { model: "test-revision" } };
    },
  };
  const setup = () => createGeoChecks({ dataDir, legacyDataDir: join(dataDir, "legacy"), platforms });
  const submit = setup();
  async function completed(service, id) {
    for (let i = 0; i < 100; i++) {
      const row = await service.result(id);
      if (row.state !== "running") return row;
      await delay(10);
    }
    assert.fail("GEO check did not finish");
  }
  const initial = await submit.create({ kind: "article", name: "Test", url: target, question: "What is the topic?", platforms: ["gpt", "gemini"], webSearch: true });
  await completed(submit, initial.id);
  const reload = setup();
  const baseline = await reload.result(initial.id);
  assert.equal(baseline.retestMode, "matched");
  assert.equal(baseline.samples[0].evidence, "text-link");
  assert.equal(baseline.samples[0].usedSearch, false);
  assert.equal(baseline.samples[0].configuredModel, "test-gpt");
  assert.equal(baseline.samples[0].modelVersion, "test-revision");
  assert.equal(baseline.samples[1].evidence, "failed");
  assert.equal(baseline.samples[1].searchRequested, true);
  assert.equal(JSON.stringify(baseline).includes("routeFingerprint"), false);
  const comparison = await reload.retest(initial.id);
  const result = await completed(reload, comparison.id);
  assert.equal(result.baselineId, initial.id);
  assert.equal(result.comparisonMode, "matched");
  assert.deepEqual(prompts.slice(0, 2), prompts.slice(2, 4));
  configuration[0].model = "new-model";
  await assert.rejects(reload.retest(initial.id, true), { status: 409 });
  assert.equal(prompts.length, 4);

  const legacyId = "12345678-1234-1234-1234-123456789012";
  await writeFile(join(dataDir, legacyId + ".json"), JSON.stringify({
    id: legacyId, kind: "article", name: "Old article", url: target, question: "Original question?",
    state: "completed", createdAt: new Date().toISOString(), samples: [{ model: "GPT", answer: "Prior answer" }],
  }));
  const old = await reload.result(legacyId);
  assert.equal(old.retestMode, "legacy");
  assert.equal(old.samples[0].searchRequested, undefined);
  assert.equal(old.samples[0].evidence, "miss");
  await assert.rejects(reload.retest(legacyId), { status: 409 });
  const diff = await reload.retest(legacyId, true);
  assert.equal((await completed(reload, diff.id)).comparisonMode, "legacy");
});

test("configured model is recorded as recently successful only after an answer", async () => {
  const platforms = createGeoPlatforms({ GEO_RELAY_BASE_URL: "https://models.example.com",
    GPT_RELAY_API_KEY: "fixture", GPT_RELAY_MODEL: "gpt-test", GPT_RELAY_VISION: "on" });
  const gpt = () => platforms.list().find((platform) => platform.id === "gpt");
  assert.equal(gpt().ready, true);
  assert.equal(gpt().lastSuccessAt, undefined);
  await withCustomProviderTransport(async () => Response.json({
    model: "test-revision", choices: [{ message: { content: "Answer" } }],
  }), () => platforms.answer("gpt", "Question"));
  assert.ok(Number.isFinite(Date.parse(gpt().lastSuccessAt)));
});

test("multi-sample retry keeps successful answers and reuses the selected search mode", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yaosight-sampling-test-"));
  let capable = true;
  const requests = [];
  const platforms = {
    list: () => [{ id: "gpt", label: "GPT", ready: true, search: capable }],
    configuration: () => ({ id: "gpt", model: "gpt", search: capable, routeFingerprint: "relay" }),
    async answer(id, prompt, options) {
      requests.push(options.webSearch);
      if (requests.length === 2) throw new Error("Upstream unavailable");
      return { text: "Answer " + requests.length, search: { used: true }, citations: [
        ...(requests.length === 3 ? [] : [{ url: "https://example.com/post?id=7&utm_source=foo", source: "response_annotation" }]),
        { url: "https://example.com/post?id=8", source: "response_annotation" },
        { url: "https://example.com:8443/post?id=7", source: "response_annotation" },
      ] };
    },
  };
  const service = createGeoChecks({ dataDir, legacyDataDir: join(dataDir, "legacy"), platforms });
  const data = { kind: "article", name: "Sample", url: "https://example.com/post?id=7",
    platforms: ["gpt"], webSearch: true, sampleCount: 3 };
  async function finish(id) {
    for (let i = 0; i < 100; i++) {
      const row = await service.result(id);
      if (row.state !== "running") return row;
      await delay(10);
    }
    assert.fail("Sampling did not finish");
  }
  await assert.rejects(service.create({ ...data, sampleCount: 2 }), { status: 400 });
  const first = await finish((await service.create(data)).id);
  assert.equal(first.canRetry, true);
  assert.deepEqual(first.samples.map((row) => row.evidence), ["citation", "failed", "miss"]);
  assert.match(first.samples[0].sources[0].url, /utm_source=foo/);
  const retry = await finish((await service.retest(first.id, false, true)).id);
  assert.equal(retry.baselineId, first.id);
  assert.equal(retry.comparisonMode, "retry");
  assert.deepEqual(retry.samples.map((row) => row.answer), ["Answer 1", "Answer 4", "Answer 3"]);
  assert.deepEqual(retry.samples.map((row) => row.retained), [true, undefined, true]);
  assert.deepEqual(retry.samples.map((row) => row.number), [1, 2, 3]);
  assert.equal(requests.length, 4);
  const repeat = await finish((await service.retest(retry.id)).id);
  assert.equal(repeat.samples.length, 3);
  assert.deepEqual(requests, Array(7).fill(true));
  capable = false;
  await assert.rejects(service.retest(first.id, false, true), { status: 409 });
  assert.equal(requests.length, 7);
});

test("relay web search uses Responses and counts provider execution independently of annotations", async () => {
  const platforms = createGeoPlatforms({ GEO_RELAY_BASE_URL: "https://models.example.com",
    GPT_RELAY_API_KEY: "fixture", GPT_RELAY_MODEL: "gpt-test", GPT_RELAY_SEARCH: "on" });
  const paths = [];
  let completed = false;
  let unavailable = false;
  await withCustomProviderTransport(async (url, options) => {
    const body = JSON.parse(options.body);
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("completions")) {
      assert.equal(body.tools, undefined);
      return Response.json({ choices: [{ message: { content: "Ordinary answer" } }] });
    }
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    if (unavailable) return Response.json({ error: { message: "fixture unavailable" } }, { status: 503 });
    return Response.json({ output: [
      ...(completed ? [{ type: "web_search_call", status: "completed" }] : []),
      { type: "message", content: [{ type: "output_text", text: "Native answer", annotations: [
        { type: "url_citation", url: "https://example.com/source", title: "Source" },
      ] }] },
    ] });
  }, async () => {
    assert.equal((await platforms.answer("gpt", "Question", { webSearch: false })).search.used, false);
    const unconfirmed = await platforms.answer("gpt", "Question", { webSearch: true });
    assert.equal(unconfirmed.search.used, false);
    assert.equal(unconfirmed.citations.length, 1);
    completed = true;
    assert.equal((await platforms.answer("gpt", "Question", { webSearch: true })).search.used, true);
    unavailable = true;
    await assert.rejects(platforms.answer("gpt", "Question", { webSearch: true }), { status: 503 });
  });
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/responses", "/v1/responses", "/v1/responses"]);
});
