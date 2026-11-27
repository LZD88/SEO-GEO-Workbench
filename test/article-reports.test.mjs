import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { articleReportMarkdown, createArticleReports } from "../article-reports.mjs";
import { createArticleOptimizer } from "../article-optimization.mjs";

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
