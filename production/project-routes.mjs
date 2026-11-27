import { pipeline } from "node:stream/promises";
import { inTransaction } from "./db.mjs";
import { prepareGeo, prepareRetest } from "./geo.mjs";
import { prepareArticleOptimization, prepareArticleSource } from "./article-jobs.mjs";
import { availablePlatforms } from "./vision.mjs";
import { prepareGeoMonitor, readMonitor, runMonitor, saveMonitor } from "./monitoring.mjs";
import { geoComparison, geoMeasurement } from "./geo-metrics.mjs";
import { beginSiteVerification, getSite, prepareSeo, verifySite } from "./sites.mjs";
import { seoComparison } from "./seo-metrics.mjs";
import { enqueue, cancelJob, getJob, usage } from "./jobs.mjs";
import { HttpError, isUuid, readJson, sendJson } from "./http.mjs";
import { requireProject } from "./workspaces.mjs";

export function createProjectRoutes({ pool, platforms, artifacts, sourceReady = false }) {
  async function submit(req, userId, scope) {
    const requestKey = req.headers["idempotency-key"];
    const payload = await readJson(req, 65536);
    return inTransaction(pool, async (db) => {
      await requireProject(db, userId, scope.workspaceId, scope.projectId, "editor", { write: true });
      let prepared;
      if (payload.kind === "geo") {
        if (!platforms) throw new HttpError(503, "尚未配置 GEO 渠道。");
        if (!Object.hasOwn(payload, "baselineId") && (!payload.target || typeof payload.target !== "object")) {
          throw new HttpError(400, "请填写检测目标。");
        }
        prepared = Object.hasOwn(payload, "baselineId")
          ? await prepareRetest(db, scope, payload, platforms)
          : prepareGeo(payload.target, platforms);
      } else if (payload.kind === "seo") {
        if (!sourceReady || !artifacts) throw new HttpError(503, "站点审计服务暂不可用。");
        prepared = await prepareSeo(db, scope, payload.target, { allowDemo: true });
      } else if (payload.kind === "article-source") {
        if (!sourceReady) throw new HttpError(503, "文章读取服务暂不可用。");
        prepared = prepareArticleSource(payload.target);
      } else if (payload.kind === "article-optimization") {
        prepared = await prepareArticleOptimization(db, scope, payload.target, platforms, { artifactReady: Boolean(artifacts) });
      } else {
        throw new HttpError(400, "请选择支持的任务类型。");
      }
      return enqueue(db, { ...scope, kind: payload.kind, requestKey, ...prepared });
    });
  }

  const prepareMonitor = (db, scope, kind, configuration) => {
    if (kind === "seo" && sourceReady && artifacts) return prepareSeo(db, scope, configuration);
    if (kind === "geo" && platforms) return prepareGeoMonitor(configuration, platforms);
    throw new HttpError(503, "监测服务暂不可用。");
  };

  async function monitorWrite(req, scope, userId, id, action) {
    const run = action === "run";
    const pause = action === "pause";
    const payload = run ? null : await readJson(req, 65536);
    return inTransaction(pool, async (db) => {
      await requireProject(db, userId, scope.workspaceId, scope.projectId, "editor", { write: true });
      if (run) return runMonitor(db, scope, id, req.headers["idempotency-key"], prepareMonitor);
      if (pause) {
        if (typeof payload.active !== "boolean") throw new HttpError(400, "无效的监测状态。");
        const monitor = await readMonitor(db, scope, id);
        const { rows: [updated] } = await db.query(`
          UPDATE yaosight.monitors SET active=$4,next_run_at=CASE WHEN $4 THEN COALESCE(next_run_at,now()) ELSE NULL END
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3 RETURNING id,active,next_run_at
        `, [scope.workspaceId, scope.projectId, monitor.id, payload.active]);
        return updated;
      }
      return saveMonitor(db, scope, payload, (kind, config) => prepareMonitor(db, scope, kind, config), id);
    });
  }

  async function download(res, scope, id) {
    if (!isUuid(id)) throw new HttpError(404, "资源不存在。");
    const { rows: [artifact] } = await pool.query(`
      SELECT name,object_key,byte_length FROM yaosight.artifacts
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [scope.workspaceId, scope.projectId, id]);
    if (!artifact) throw new HttpError(404, "资源不存在。");
    if (!artifacts) throw new HttpError(503, "报告存储暂不可用。");
    let object;
    try { object = await artifacts.read(artifact.object_key); }
    catch (error) {
      if (["NoSuchKey", "NotFound"].includes(error.name)) throw new HttpError(404, "报告产物不存在。");
      throw error;
    }
    const name = artifact.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "report";
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="' + name + '"',
      "Content-Length": artifact.byte_length,
      "Cache-Control": "private, no-store",
    });
    return pipeline(object.Body, res);
  }

  return async function route(req, res, url, userId, scope, segments) {
    const [section, id, action, ...rest] = segments;
    if (rest.length) throw new HttpError(404, "资源不存在。");
    if (req.method === "POST" && section === "jobs" && !id) {
      return sendJson(res, 202, await submit(req, userId, scope));
    }
    if (req.method === "POST" && section === "jobs" && id && action === "cancel") {
      const result = await inTransaction(pool, async (db) => {
        await requireProject(db, userId, scope.workspaceId, scope.projectId, "editor", { write: true });
        return cancelJob(db, { ...scope, jobId: id });
      });
      return sendJson(res, 200, result);
    }
    if (section === "site" && req.method === "POST" && !action && ["challenge", "verify"].includes(id)) {
      const payload = id === "challenge" ? await readJson(req) : null;
      const site = await inTransaction(pool, async (db) => {
        await requireProject(db, userId, scope.workspaceId, scope.projectId, "editor", { write: true });
        if (payload) return beginSiteVerification(db, scope, payload.domain);
        return verifySite(db, scope, await getSite(db, scope));
      });
      return sendJson(res, 200, site);
    }
    if (section === "monitors" && (
      (req.method === "POST" && (!id || ["run", "pause"].includes(action))) ||
      (req.method === "PATCH" && id && !action))) {
      return sendJson(res, action === "run" ? 202 : 200, await monitorWrite(req, scope, userId, id, action));
    }
    if (req.method !== "GET") throw new HttpError(404, "资源不存在。");
    await requireProject(pool, userId, scope.workspaceId, scope.projectId);
    const keys = [scope.workspaceId, scope.projectId];
    if (section === "jobs" && !action) {
      if (id) {
        const job = await getJob(pool, { ...scope, jobId: id });
        const beforeId = url.searchParams.get("baseline") ?? job.baseline_id;
        const baseline = beforeId ? await getJob(pool, { ...scope, jobId: beforeId }) : null;
        const olderSeo = baseline?.kind === "seo" && baseline.steps[0]?.result;
        const newSeo = job.kind === "seo" && job.steps[0]?.result;
        return sendJson(res, 200, {
          ...job, ...(job.kind === "geo" && {
            measurement: geoMeasurement(job),
            comparison: baseline ? geoComparison(baseline, job) : null,
          }),
          ...(olderSeo && newSeo && { seoComparison: seoComparison(olderSeo, newSeo) }),
        });
      }
      const cursor = url.searchParams.get("before");
      if (cursor && !isUuid(cursor)) throw new HttpError(400, "分页参数无效。");
      const { rows } = await pool.query(`
        SELECT id,kind,status,created_at,finished_at,input->>'name' AS name,input->>'url' AS url
        FROM yaosight.jobs j WHERE workspace_id=$1 AND project_id=$2
          AND ($3::uuid IS NULL OR (j.created_at,j.id) < (
            SELECT created_at,id FROM yaosight.jobs WHERE workspace_id=$1 AND project_id=$2 AND id=$3
          ))
        ORDER BY created_at DESC,id DESC LIMIT 50
      `, [...keys, cursor]);
      return sendJson(res, 200, rows);
    }
    if (section === "monitors" && !action) {
      if (id) {
        const plan = await readMonitor(pool, scope, id);
        const { rows: periods } = await pool.query(`
          SELECT slot,job_id,status FROM yaosight.monitor_periods
          WHERE workspace_id=$1 AND project_id=$2 AND monitor_id=$3 ORDER BY slot DESC LIMIT 25
        `, [...keys, id]);
        let trend;
        if (plan.kind === "geo") {
          const observations = [];
          for (const period of periods.filter(({ job_id }) => job_id).slice(0, 12).reverse()) {
            const job = await getJob(pool, { ...scope, jobId: period.job_id });
            if (!["succeeded", "partial", "failed", "review"].includes(job.status)) continue;
            const measurement = geoMeasurement(job);
            if (measurement) observations.push({ job, slot: period.slot, measurement });
          }
          trend = observations.map(({ job, slot, measurement }, index) => ({
            jobId: job.id,
            slot,
            questionSetVersion: job.input.questionSetVersion,
            models: measurement.map(({ id, valid, planned, nativeCitations, comparable }) => ({
              id, valid, planned, nativeCitations, comparable,
            })),
            changes: index ? geoComparison(observations[index - 1].job, job) : [],
          }));
        }
        return sendJson(res, 200, { ...plan, periods, trend });
      }
      const { rows } = await pool.query(`
        SELECT id,name,kind,cadence,time_zone,active,next_run_at FROM yaosight.monitors
        WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 100
      `, keys);
      return sendJson(res, 200, rows);
    }
    if (section === "platforms" && !id) return sendJson(res, 200, await availablePlatforms(pool, platforms));
    if (section === "features" && !id) return sendJson(res, 200, {
      articleSource: sourceReady, articleReports: Boolean(artifacts), seo: sourceReady && Boolean(artifacts),
    });
    if (section === "site" && !id) return sendJson(res, 200, await getSite(pool, scope));
    if (section === "usage" && !id) return sendJson(res, 200, await usage(pool, scope.workspaceId));
    if (section === "reports" && id && !action) return download(res, scope, id);
    if (section === "jobs" && id && action === "markdown") {
      const job = await getJob(pool, { ...scope, jobId: id });
      const markdown = job.kind === "article-optimization" && job.input.historical && job.steps[0]?.result?.markdown;
      if (typeof markdown !== "string") throw new HttpError(404, "资源不存在。");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="article-report.md"',
      });
      return res.end(markdown);
    }
    throw new HttpError(404, "资源不存在。");
  };
}
