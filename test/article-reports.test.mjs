import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { articleReportMarkdown, createArticleReports } from "../article-reports.mjs";
import { createArticleOptimizer } from "../article-optimization.mjs";
import { createArticleContext } from "../article-context.mjs";

test("optimization reports survive service recreation and retain GEO provenance", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "yaosight-report-test-")), "reports");
  const store = createArticleReports(directory);
  assert.deepEqual(await store.list(), []);
  const checkId = "12345678-1234-1234-1234-123456789012";
  const checks = { result: async () => ({ id: checkId, kind: "article", state: "completed", samples: [] }) };
  const platforms = { list: () => [{ id: "gpt", label: "GPT", ready: true, vision: true }],
    answer: async () => ({ text: "## 改写建议\n\n保留具体证据。", modelVersion: "fixture" }) };
  const optimize = createArticleOptimizer(checks, platforms);
  const report = await store.save(await optimize({
    title: "测试文章", text: "Private input that must not be written to the archive.", platform: "gpt", checkId,
  }));
  const restarted = createArticleReports(directory);
  assert.deepEqual(await restarted.read(report.id), report);
  const [{ id, title, model, checkId: linked, markdown }] = await restarted.list();
  assert.deepEqual([id, title, model, linked, markdown], [report.id, "测试文章", "fixture", checkId, undefined]);
  const download = articleReportMarkdown(await restarted.read(report.id));
  assert.ok(download.includes(report.markdown) && download.includes(checkId));
  assert.equal(download.includes("Private input"), false);
  await assert.rejects(restarted.read("../other"), { status: 400 });
  await assert.rejects(restarted.read(checkId), { status: 404 });
  platforms.answer = async () => { throw new Error("Provider failed"); };
  await assert.rejects(optimize({
    title: "Failed", text: "Another input that is long enough to analyze.", platform: "gpt",
  }), { status: 502 });
  assert.deepEqual(await readdir(directory), [report.id + ".json"]);
});

test("reuses saved article images and can optimize from older GEO evidence alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaosight-article-context-"));
  const id = "12345678-1234-1234-1234-123456789012";
  const image = { number: 1, type: "image/png", base64: Buffer.from("89504e470d0a1a0a00", "hex").toString("base64") };
  const article = { title: "测试文章", text: "This article already has a usable introduction and an image. [图1]", images: [image] };
  const check = { id, kind: "article", state: "completed", url: "https://example.com/guide", question: "What guidance is available?",
    samples: [{ model: "GPT", answer: "The guide is available.", cited: true, sources: [{ type: "citation", url: "https://example.com/guide" }] }] };
  let reads = 0;
  const original = createArticleContext(dir, async () => { reads++; return article; });
  original.prepare(check);
  const [first, second] = await Promise.all([original.load(check), original.load(check)]);
  assert.deepEqual(first, second);
  const reopened = createArticleContext(dir, async () => assert.fail("Saved image and text should not be fetched again"));
  assert.deepEqual(await reopened.find(check), { status: "ready", article });
  assert.deepEqual(await reopened.load(check), article);
  assert.equal(reads, 1);
  const blocked = { ...check, id: "12345678-1234-1234-1234-123456789013" };
  const unavailable = createArticleContext(dir, async () => { throw new Error("Page unavailable"); });
  await assert.rejects(unavailable.load(blocked), /Page unavailable/);
  assert.deepEqual(await reopened.find(blocked), { status: "unavailable" });
  const prompts = [];
  const platforms = {
    list: () => [{ id: "gpt", label: "GPT", ready: true, vision: true }],
    answer: async (_id, prompt, options) => { prompts.push({ prompt, options }); return { text: "## 建议" }; },
  };
  let evidence = check;
  const optimize = createArticleOptimizer({ result: async () => evidence }, platforms);
  const result = await optimize({ title: article.title, evidenceOnly: true, platform: "gpt", checkId: id });
  assert.match(result.markdown, /基于关联的 GEO 检测结果/);
  assert.equal(result.checkId, id);
  assert.match(prompts[0].prompt, /保留已被引用的原文入口/);
  assert.match(prompts[0].prompt, /The guide is available/);
  assert.doesNotMatch(prompts[0].prompt, /Photo description|usable introduction/);
  assert.equal(prompts[0].options.images.length, 0);
  await optimize({ ...article, platform: "gpt", checkId: id });
  assert.match(prompts[1].prompt, /usable introduction/);
  assert.equal(prompts[1].options.images.length, 1);
  evidence = { ...check, state: "failed", samples: [{ error: "Unavailable" }] };
  await assert.rejects(optimize({ title: article.title, evidenceOnly: true, platform: "gpt", checkId: id }), { status: 409 });
});
