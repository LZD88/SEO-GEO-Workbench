import { createArticleOptimizer, articleBodyLimit } from "../article-optimization.mjs";
import { articleReportMarkdown } from "../article-reports.mjs";
import { HttpError, isUuid } from "./http.mjs";
import { getJob } from "./jobs.mjs";
import { hasVerifiedVision } from "./vision.mjs";
import { modelOutcome } from "./geo.mjs";

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

export async function prepareArticleOptimization(db, scope, payload, platforms, { artifactReady }) {
  if (!artifactReady) throw new HttpError(503, "报告存储暂不可用。");
  if (!(await hasVerifiedVision(db, platforms, payload?.platform))) throw new HttpError(409, "请选择已验证支持识图的模型。");
  const { title, text, question, platform } = payload;
  const checkId = payload.checkId || undefined;
  const sourceId = payload.sourceId || undefined;
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 180 ||
      (text !== undefined && (typeof text !== "string" || text.trim().length < 30 || text.length > 12000)) ||
      (question !== undefined && (typeof question !== "string" || question.length > 240))) {
    throw new HttpError(400, "请填写有效的标题和正文。");
  }
  if (sourceId) {
    const source = await getJob(db, { ...scope, jobId: sourceId });
    if (source.kind !== "article-source" || source.status !== "succeeded") throw new HttpError(409, "文章读取尚未完成。");
  } else if (!text) {
    throw new HttpError(400, "请先导入或粘贴文章正文。");
  }
  if (checkId) {
    const check = await getJob(db, { ...scope, jobId: checkId });
    if (check.kind !== "geo" || check.input.kind !== "article" || ["queued", "running"].includes(check.status)) {
      throw new HttpError(409, "请选择已完成的文章 GEO 检测。");
    }
  }
  const configuration = platforms.configuration(platform);
  const input = { name: title, title, text, question, platform, checkId, sourceId, configuration };
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
        return { ...check.input, id: check.id, state: check.status, samples: check.steps.map(({ result }) => result ?? {}) };
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
