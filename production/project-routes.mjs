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
import { evaluationSettings, normalizeEvaluation, publicJob, publicPlan, withEvaluation } from "./evaluation.mjs";

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
          : prepareGeo(withEvaluation("geo", payload.target, await evaluationSettings(db, scope), platforms), platforms);
      } else if (payload.kind === "seo") {
        if (!sourceReady || !artifacts) throw new HttpError(503, "站点审计服务暂不可用。");
        prepared = await prepareSeo(db, scope, withEvaluation("seo", payload.target, await evaluationSettings(db, scope)), { allowDemo: true });
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
      const settings = await evaluationSettings(db, scope);
      const configuration = withEvaluation(payload.kind, payload.configuration, settings, platforms);
      if (payload.kind === "geo" && id && Array.isArray(configuration.competitors)) {
        const previous = await readMonitor(db, scope, id);
        const registered = new Map((previous.configuration.competitors ?? []).map((item) => [item.name, item]));
        configuration.competitors = configuration.competitors.map((item) => registered.get(item?.name) ?? item);
      }
      return saveMonitor(db, scope, { ...payload, configuration }, (kind, config) => prepareMonitor(db, scope, kind, config), id);
    });
  }

  async function download(res, scope, id, isOperator) {
    if (!isUuid(id)) throw new HttpError(404, "资源不存在。");
    const { rows: [artifact] } = await pool.query(`
      SELECT name,object_key,byte_length,media_type FROM yaosight.artifacts
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [scope.workspaceId, scope.projectId, id]);
    if (!artifact || (!isOperator && artifact.media_type !== "text/markdown")) throw new HttpError(404, "资源不存在。");
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

  return async function route(req, res, url, userId, scope, segments, isOperator) {
    const [section, id, action, ...rest] = segments;
    if (rest.length) throw new HttpError(404, "资源不存在。");
    if (section === "evaluation") {
      if (!isOperator) throw new HttpError(404, "资源不存在。");
      await requireProject(pool, userId, scope.workspaceId, scope.projectId);
      if (req.method === "GET" && !id) {
        const channels = (platforms?.list() ?? []).map((entry) => ({ ...entry, ...platforms.configuration(entry.id) }));
        const { rows: reports } = await pool.query(`
          SELECT id,name,created_at FROM yaosight.artifacts WHERE workspace_id=$1 AND project_id=$2 AND media_type<>'text/markdown'
          ORDER BY created_at DESC LIMIT 50
        `, [scope.workspaceId, scope.projectId]);
        const { rows: monitors } = await pool.query(`
          SELECT m.name,v.version,v.configuration FROM yaosight.monitors m JOIN yaosight.monitor_versions v
          ON (m.workspace_id,m.project_id,m.id,m.current_version)=(v.workspace_id,v.project_id,v.monitor_id,v.version)
          WHERE m.workspace_id=$1 AND m.project_id=$2 ORDER BY m.created_at DESC LIMIT 50
        `, [scope.workspaceId, scope.projectId]);
        return sendJson(res, 200, { settings: await evaluationSettings(pool, scope), channels, reports, monitors });
      }
      if (req.method === "GET" && id && !action) {
        const job = await getJob(pool, { ...scope, jobId: id, includeStepInputs: true });
        if (!["geo", "seo"].includes(job.kind)) throw new HttpError(404, "资源不存在。");
        return sendJson(res, 200, job);
      }
      if (req.method === "POST" && !id) {
        const settings = normalizeEvaluation(await readJson(req));
        await inTransaction(pool, async (db) => {
          await requireProject(db, userId, scope.workspaceId, scope.projectId, "editor", { write: true });
          await db.query("UPDATE yaosight.projects SET evaluation_settings=$3 WHERE workspace_id=$1 AND id=$2",
            [scope.workspaceId, scope.projectId, JSON.stringify(settings)]);
          await db.query(`
            INSERT INTO yaosight.audit_events(workspace_id,actor_id,action,target,result)
            VALUES($1,$2,'evaluation.updated',$3,'success')
          `, [scope.workspaceId, userId, scope.projectId]);
        });
        return sendJson(res, 200, settings);
      }
      throw new HttpError(404, "资源不存在。");
    }
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
        return sendJson(res, 200, publicJob(job, {
          measurement: job.kind === "geo" ? geoMeasurement(job) : undefined,
          comparison: baseline && job.kind === "geo" ? geoComparison(baseline, job) : undefined,
          seoComparison: olderSeo && newSeo && Array.isArray(olderSeo.findings) && Array.isArray(newSeo.findings)
            ? seoComparison(olderSeo, newSeo) : undefined,
        }));
      }
      const cursor = url.searchParams.get("before");
      if (cursor && !isUuid(cursor)) throw new HttpError(400, "分页参数无效。");
      const { rows } = await pool.query(`
        SELECT id,kind,status,created_at,finished_at,input->>'name' AS name,input->>'url' AS url,input->>'kind' AS target_kind
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
        return sendJson(res, 200, publicPlan({ ...plan, periods, trend }));
      }
      const { rows } = await pool.query(`
        SELECT id,name,kind,cadence,time_zone,active,next_run_at FROM yaosight.monitors
        WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 100
      `, keys);
      return sendJson(res, 200, rows);
    }
    if (section === "platforms" && !id) {
      const list = await availablePlatforms(pool, platforms);
      return sendJson(res, 200, list.map(({ id: platformId, label, ready, vision }) => ({ id: platformId, label, ready, vision })));
    }
    if (section === "features" && !id) return sendJson(res, 200, {
      articleSource: sourceReady, articleReports: Boolean(artifacts), seo: sourceReady && Boolean(artifacts),
    });
    if (section === "site" && !id) return sendJson(res, 200, await getSite(pool, scope));
    if (section === "usage" && !id && isOperator) return sendJson(res, 200, await usage(pool, scope.workspaceId));
    if (section === "reports" && id && !action) return download(res, scope, id, isOperator);
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
