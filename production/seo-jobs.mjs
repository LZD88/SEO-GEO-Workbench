import { HttpError } from "./http.mjs";
import { prepareSeo } from "./sites.mjs";
import { seoDemo } from "./demo-seo.mjs";
import { parseSeoReport } from "./seo-metrics.mjs";

const artifactsToStore = [
  ["raw", "siteone-report.json", "application/json"],
  ["html", "siteone-report.html", "text/html"],
];

export function createSeoHandler(pool, { fetchService, token, artifacts }) {
  const endpoint = fetchService ? new URL("/crawl", fetchService) : null;
  return async (step, job) => {
    if (!endpoint || !token || !artifacts) return { state: "failed", units: 0, category: "seo_unavailable" };
    const scope = { workspaceId: job.workspace_id, projectId: job.project_id };
    const demo = step.input.demo === true;
    let crawl;
    if (demo) {
      const { report, html, config } = seoDemo();
      crawl = {
        parsed: parseSeoReport(report, config),
        raw: Buffer.from(JSON.stringify(report)).toString("base64"),
        html: Buffer.from(html).toString("base64"),
      };
    } else {
      try { await prepareSeo(pool, scope, step.input); }
      catch (error) {
        if (error instanceof HttpError) return { state: "failed", units: 0, category: "site_not_verified" };
        throw error;
      }
      try {
        const response = await fetch(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(190000),
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify(step.input),
        });
        if (response.status === 429 && step.attempts < 3) return { state: "queued", category: "fetch_busy" };
        if (response.status === 429) return { state: "failed", units: 0, category: "fetch_busy" };
        if (!response.ok) return { state: "review", category: "crawl_outcome_unknown" };
        crawl = await response.json();
      } catch {
        return { state: "review", category: "crawl_outcome_unknown" };
      }
    }
    const used = demo ? 0 : crawl.parsed.visited;
    if (!Number.isInteger(used) || used < 0 || used > step.estimated_units) {
      return { state: "review", category: "crawl_coverage_unknown" };
    }
    const reports = [];
    try {
      for (const [field, name, mediaType] of artifactsToStore) {
        const content = Buffer.from(crawl[field], "base64");
        const key = await artifacts.put(scope.workspaceId, scope.projectId, content, mediaType);
        const { rows: [row] } = await pool.query(`
          INSERT INTO yaosight.artifacts(workspace_id,project_id,object_key,name,media_type,byte_length)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id
        `, [scope.workspaceId, scope.projectId, key, name, mediaType, content.length]);
        reports.push({ id: row.id, name });
      }
    } catch {
      return { state: "failed", units: used, category: "report_storage_failed" };
    }
    return { state: "succeeded", units: used, result: { ...crawl.parsed, reports } };
  };
}
