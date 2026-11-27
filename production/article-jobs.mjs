import { createArticleOptimizer, articleBodyLimit } from "../article-optimization.mjs";
import { articleReportMarkdown } from "../article-reports.mjs";
import { HttpError, isUuid } from "./http.mjs";
import { getJob } from "./jobs.mjs";
import { hasVerifiedVision } from "./vision.mjs";
import { modelOutcome } from "./geo.mjs";
import { hasArticleEvidence } from "../public/article-evidence.js";

export function prepareArticleSource(target) {
  let url;
  try { url = new URL(target?.url); }
  catch { throw new HttpError(400, "请输入公开文章链接。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || url.href.length > 2048) {
    throw new HttpError(400, "请输入公开文章链接。");
  }
  url.hash = "";
  const input = { url: url.href };
  return { input, steps: [{ category: "source_limit", estimate: 1, input }] };
}

export function articleEvidence(job) {
  return {
    ...job.input, id: job.id, state: job.status,
    samples: job.steps.map(({ result, state }) => ({
      ...result, error: state !== "succeeded" ? "该样本未完成。" : result?.error,
    })),
  };
}

export async function findArticleJob(db, scope, check) {
  const visited = new Set();
  let current = check;
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const { rows: [source] } = await db.query(`
      SELECT id, status FROM yaosight.jobs WHERE workspace_id=$1 AND project_id=$2 AND kind='article-source'
        AND baseline_id=$3 ORDER BY created_at DESC, id DESC LIMIT 1
    `, [scope.workspaceId, scope.projectId, current.id]);
    if (source) return source;
    if (current.input.comparisonMode !== "retry" || !current.baseline_id) return null;
    current = await getJob(db, { ...scope, jobId: current.baseline_id });
  }
  return null;
}

export async function prepareArticleOptimization(db, scope, payload, platforms, { artifactReady }) {
  if (!artifactReady) throw new HttpError(503, "报告存储暂不可用。");
  if (!(await hasVerifiedVision(db, platforms, payload?.platform))) throw new HttpError(409, "请选择已验证支持识图的模型。");
  const { title, question, platform } = payload;
  const text = typeof payload.text === "string" && !payload.text.trim() ? undefined : payload.text;
  const checkId = payload.checkId || undefined;
  const sourceId = payload.sourceId || undefined;
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 180 ||
      (text !== undefined && (typeof text !== "string" || text.trim().length < 30 || text.length > 12000)) ||
      (question !== undefined && (typeof question !== "string" || question.length > 240))) {
    throw new HttpError(400, "请填写有效的标题和正文。");
  }
  const check = checkId ? await getJob(db, { ...scope, jobId: checkId }) : null;
  if (check && (check.kind !== "geo" || check.input.kind !== "article" || ["queued", "running"].includes(check.status))) {
    throw new HttpError(409, "请选择已完成的文章 GEO 检测。");
  }
  const saved = check && !sourceId && !text ? await findArticleJob(db, scope, check) : null;
  const selectedSource = sourceId ?? (saved?.status === "succeeded" ? saved.id : undefined);
  if (selectedSource) {
    const source = await getJob(db, { ...scope, jobId: selectedSource });
    if (source.kind !== "article-source" || source.status !== "succeeded") throw new HttpError(409, "文章读取尚未完成。");
    if (check && source.input.url !== check.input.url) throw new HttpError(409, "正文与所选检测的文章链接不一致。");
  }
  const evidenceOnly = !text && !selectedSource;
  if (evidenceOnly && !(check && hasArticleEvidence(articleEvidence(check)))) {
    throw new HttpError(400, "请先选择有结果的文章检测，或补充文章正文。");
  }
  const configuration = platforms.configuration(platform);
  const input = { name: title, title, text, question, platform, checkId, sourceId: selectedSource, configuration, evidenceOnly };
  return { input, steps: [{ channel: platform, category: "model_limit", estimate: 1, input }] };
}

export function createArticleHandlers(pool, platforms, { fetchService, token, artifacts }) {
  const endpoint = fetchService ? new URL("/article", fetchService) : null;
  return {
    async "article-source"(step) {
      if (!endpoint || !token) return { state: "failed", units: 0, category: "fetch_unavailable" };
      try {
        const response = await fetch(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(24000),
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify(step.input),
        });
        if (response.status === 429 && step.attempts < 3) return { state: "queued", category: "fetch_busy" };
        if (!response.ok) return { state: "failed", units: response.status === 429 ? 0 : 1, category: "article_unavailable" };
        const result = await response.json();
        if (JSON.stringify(result).length > articleBodyLimit) return { state: "failed", units: 1, category: "source_too_large" };
        return { state: "succeeded", units: 1, result };
      } catch {
        return { state: "review", category: "fetch_outcome_unknown" };
      }
    },
    async "article-optimization"(step, job) {
      const { platform, checkId, sourceId, configuration } = step.input;
      const scope = { workspaceId: job.workspace_id, projectId: job.project_id };
      if (!artifacts) return { state: "failed", units: 0, category: "store_unavailable" };
      if (!(await hasVerifiedVision(pool, platforms, platform))) return { state: "failed", units: 0, category: "vision_unverified" };
      const current = platforms.configuration(platform);
      if (configuration.model !== current.model || configuration.routeFingerprint !== current.routeFingerprint) {
        return { state: "failed", units: 0, category: "model_configuration_changed" };
      }
      const source = sourceId ? (await getJob(pool, { ...scope, jobId: sourceId })).steps[0]?.result : undefined;
      const text = step.input.text ?? source?.text;
      const images = source?.images ?? [];
      const checks = { async result(id) {
        if (id !== checkId || !isUuid(id)) throw new HttpError(404, "资源不存在。");
        const check = await getJob(pool, { ...scope, jobId: id });
        return articleEvidence(check);
      } };
      let report;
      try {
        report = await createArticleOptimizer(checks, platforms)({ ...step.input, text, images });
      } catch (error) {
        if (error?.cause) return modelOutcome(error.cause, step.attempts);
        if (error?.status === 502) return { state: "failed", units: 1, category: "empty_answer" };
        return { state: "failed", units: 0, category: "report_input_invalid" };
      }
      const document = Buffer.from(articleReportMarkdown(report, { includeModel: false }));
      let artifact;
      try {
        const key = await artifacts.put(scope.workspaceId, scope.projectId, document, "text/markdown");
        const { rows: [row] } = await pool.query(`
          INSERT INTO yaosight.artifacts(workspace_id,project_id,object_key,name,media_type,byte_length)
          VALUES($1,$2,$3,'article-report.md','text/markdown',$4) RETURNING id
        `, [scope.workspaceId, scope.projectId, key, document.length]);
        artifact = row.id;
      } catch {
        return { state: "failed", units: 1, category: "report_storage_failed" };
      }
      return { state: "succeeded", units: 1, result: { ...report, artifact } };
    },
  };
}
