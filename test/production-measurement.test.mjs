import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { geoMeasurement, geoComparison } from "../production/geo-metrics.mjs";
import { parseSeoReport, seoComparison } from "../production/seo-metrics.mjs";

const article = "https://example.com/";
const config = { url: article, host: "example.com", path: "/", pages: 20, depth: 3, rate: 2 };

test("SiteOne 2.5.1 findings include page evidence and keep unvisited issues unresolved", async () => {
  const report = JSON.parse(await readFile(new URL("./fixtures/siteone-2.5.1.json", import.meta.url), "utf8"));
  const parsed = parseSeoReport(report, config, {
    canonical: { [article]: null }, sitemap: { verified: true, valid: false, url: article + "sitemap.xml" },
  });
  for (const expected of ["broken-link","redirect","noindex","canonical","robots-blocked","sitemap","title-missing","title-duplicate"]) {
    assert.ok(parsed.findings.some(({ rule }) => rule === expected), expected);
  }
  const missing = parsed.findings.find(({ rule }) => rule === "broken-link");
  assert.deepEqual(missing.evidence, { status: 404, target: article + "missing" });
  assert.equal(missing.url, article);
  const updated = structuredClone(report);
  updated.results = updated.results.filter(({ url }) => url !== article + "notitle");
  updated.tables["404"].rows = [];
  updated.results.find(({ url }) => url === article + "missing").status = "200";
  const next = parseSeoReport(updated, config, {
    canonical: { [article]: article }, sitemap: { verified: true, valid: true },
  });
  const compared = seoComparison(parsed, next);
  assert.equal(compared.find(({ rule }) => rule === "broken-link").state, "fixed");
  assert.equal(compared.find(({ rule }) => rule === "canonical").state, "fixed");
  assert.equal(compared.find(({ rule }) => rule === "title-missing").state, "unverified");
  assert.equal(seoComparison(parsed, { ...next, ruleVersion: 2 }).find(({ rule }) => rule === "canonical").state, "unverified");
});

test("GEO denominators separate official sources, ambiguous names and retained evidence", () => {
  const current = {
    kind: "geo", input: {
      kind: "brand", name: "Alpha", url: article, question: "怎样选服务？", questionSetVersion: 1, minimumCoverage: 0.8,
      competitors: [{ name: "Beta", aliases: ["Alpha"], domains: ["beta.com"] }],
      configuration: [{ id: "gpt", model: "model-a", channelType: "relay-api", routeFingerprint: "route-a", search: true }],
    },
    steps: [
      { channel: "gpt", state: "succeeded", result: { evidenceId: "p1", answer: "Alpha 和 Beta 都提供该服务。", cited: false,
        modelVersion: "model-a-1", searchStatus: "confirmed", sources: [
          { url: "https://beta.com/guide", type: "citation" }, { url: "https://example.com/", type: "text" },
        ] } },
      { channel: "gpt", state: "succeeded", result: { evidenceId: "p2", answer: "只看到 Beta。", cited: true,
        modelVersion: "model-a-1", searchStatus: "confirmed", sources: [{ url: article, type: "citation" }] } },
      { channel: "gpt", state: "succeeded", result: { evidenceId: "p1", answer: "Alpha 和 Beta 都提供该服务。", retained: true } },
      { channel: "gpt", state: "failed" },
      { channel: "gpt", state: "review" },
    ],
  };
  const [result] = geoMeasurement(current);
  assert.equal(result.planned, 5);
  assert.equal(result.valid, 2);
  assert.equal(result.confirmedSearch, 2);
  assert.equal(result.awaitingReview, 1);
  assert.equal(result.nativeCitations.count, 1);
  assert.equal(result.entities[0].mention.excluded, 1);
  assert.equal(result.entities[1].mention.count, 2);
  assert.equal(result.entities[1].sources[0].evidence[0], "p1");
  assert.equal(geoComparison(current, current)[0].status, "insufficient_samples");
  const later = structuredClone(current);
  later.input.configuration[0].routeFingerprint = "route-b";
  assert.equal(geoComparison(current, later)[0].status, "configuration_changed");
});
