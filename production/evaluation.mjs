import { HttpError, isUuid } from "./http.mjs";

export const defaultEvaluation = Object.freeze({
  sampleCount: 1, webSearch: true, minimumCoverage: 0.8, pages: 40, depth: 3, rate: 2, path: "/",
});

export function normalizeEvaluation(value) {
  const { sampleCount, webSearch, minimumCoverage, pages, depth, rate, path } = value;
  if (![1, 3, 5].includes(sampleCount) || typeof webSearch !== "boolean" ||
      !Number.isFinite(minimumCoverage) || minimumCoverage < 0.5 || minimumCoverage > 1 ||
      !Number.isInteger(pages) || pages < 1 || pages > 100 || ![1, 2, 3, 4, 5].includes(depth) || ![1, 2].includes(rate) ||
      typeof path !== "string" || path.length > 512 || !/^\/(?:[a-zA-Z0-9._~-]+\/)*$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")) {
    throw new HttpError(400, "评测参数无效，请检查取值范围。");
  }
  return { sampleCount, webSearch, minimumCoverage, pages, depth, rate, path };
}

export async function evaluationSettings(db, { workspaceId, projectId }) {
  const { rows: [row] } = await db.query(
    "SELECT evaluation_settings FROM yaosight.projects WHERE workspace_id=$1 AND id=$2", [workspaceId, projectId],
  );
  if (!row) throw new HttpError(404, "资源不存在。");
  return { ...defaultEvaluation, ...row.evaluation_settings };
}

export function withEvaluation(kind, target, settings, platforms) {
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new HttpError(400, "请填写检测目标。");
  if (kind === "geo") {
    const selected = Array.isArray(target.platforms) ? target.platforms : [];
    const searchable = platforms?.list().some(({ ready, search, id }) => ready && search && selected.includes(id));
    return { ...target, sampleCount: settings.sampleCount, webSearch: settings.webSearch && Boolean(searchable),
      minimumCoverage: settings.minimumCoverage };
  }
  return { ...target, path: settings.path, pages: settings.pages, depth: settings.depth, rate: settings.rate };
}

export function adminAccounts(value = "") {
  const ids = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (ids.some((id) => !isUuid(id))) throw new Error("YAOSIGHT_ADMIN_ACCOUNTS must contain PostgreSQL account UUIDs");
  return new Set(ids);
}

export function cleanTrend(trend) {
  return trend?.map(({ jobId, slot, models, changes }) => ({
    jobId, slot,
    models: models.map(({ id, valid, nativeCitations }) => ({ id, hasResults: valid > 0, hasCitation: nativeCitations.count > 0 })),
    changes: changes.map(({ id, status, citationDifference }) => ({ id, status, citationDifference })),
  }));
}

export function publicPlan(plan) {
  const { id, name, kind, cadence, active, next_run_at, periods, trend, configuration } = plan;
  const { url, questions, competitors, platforms } = configuration;
  return {
    id, name, kind, cadence, active, next_run_at, periods, trend: cleanTrend(trend),
    configuration: {
      url, ...(kind === "geo" && {
        kind: configuration.kind, name: configuration.name, questions,
        competitors: competitors?.map(({ name: competitor }) => ({ name: competitor })), platforms,
      }),
    },
  };
}

function publicStep(kind, { state, result, channel }) {
  if (!result) return { state, channel };
  if (kind === "geo") {
    const { platformId, model, answer, sources, cited, textMatch, mentioned, evidenceId, error } = result;
    return { state, channel, result: { platformId, model, answer, sources, cited, textMatch, mentioned, evidenceId,
      error: error ? "这个平台暂时没有返回可用的回答。" : undefined } };
  }
  if (kind === "seo" && Array.isArray(result.findings)) {
    const { visited, findings } = result;
    return { state, result: { visited, findings } };
  }
  if (kind === "article-optimization") {
    const { title, platform, generatedAt, checkId, markdown, artifact } = result;
    return { state, result: { title, platform, generatedAt, checkId, markdown, artifact } };
  }
  return { state, result };
}

export function publicJob(job, { measurement, comparison, seoComparison } = {}) {
  const { id, kind, status, created_at, finished_at, baseline_id } = job;
  const { name, url, historical } = job.input;
  return {
    id, kind, status, created_at, finished_at, baseline_id,
    targetKind: kind === "geo" ? job.input.kind : undefined,
    input: { name, url, historical },
    steps: job.steps.map((step) => publicStep(kind, step)),
    measurement: measurement?.map(({ id, valid, nativeCitations, entities }) => ({
      id, hasResults: valid > 0, hasCitation: nativeCitations.count > 0,
      entities: entities.map(({ name, mention, cited, sources }) => ({ name, mentioned: mention.count > 0, cited: cited.count > 0, sources })),
    })),
    comparison, seoComparison,
  };
}
