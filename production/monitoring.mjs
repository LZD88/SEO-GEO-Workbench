import { inTransaction } from "./db.mjs";
import { GeoError } from "../geo-checks.mjs";
import { prepareGeo } from "./geo.mjs";
import { enqueue } from "./jobs.mjs";
import { HttpError, isUuid, nameField } from "./http.mjs";

const keysOf = ({ workspaceId, projectId }) => [workspaceId, projectId];

function validateMonitor(body) {
  if (!["daily", "weekly"].includes(body.cadence) || typeof body.active !== "boolean") {
    throw new HttpError(400, "请设置监测频率和启用状态。");
  }
  const timeZone = body.timeZone ?? "Asia/Shanghai";
  try {
    if (typeof timeZone !== "string" || timeZone.length > 80 || /^[-+]/.test(timeZone)) throw new Error();
    new Intl.DateTimeFormat("zh-CN", { timeZone });
  } catch { throw new HttpError(400, "请选择有效时区。"); }
  return { name: nameField(body.name), cadence: body.cadence, timeZone, active: body.active };
}

function prepareCompetitors(value = []) {
  if (!Array.isArray(value) || value.length > 5) throw new HttpError(400, "每个项目支持最多五个竞品。");
  return value.map((item) => {
    if (!item || !Array.isArray(item.aliases ?? []) || !Array.isArray(item.domains ?? []) ||
        (item.aliases?.length ?? 0) > 6 || (item.domains?.length ?? 0) > 6) {
      throw new HttpError(400, "竞品别名或域名无效。");
    }
    const domains = (item.domains ?? []).map((value) => {
      if (typeof value !== "string" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value)) {
        throw new HttpError(400, "请输入竞品的完整域名。");
      }
      return value.toLowerCase();
    });
    return { name: nameField(item.name), aliases: (item.aliases ?? []).map(nameField), domains };
  });
}

export function prepareGeoMonitor(configuration, platforms) {
  const questions = configuration?.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 10 || new Set(questions).size !== questions.length ||
      questions.some((question) => typeof question !== "string" || question.trim().length < 2 || question.length > 240)) {
    throw new HttpError(400, "请提供 1 至 10 个不重复的检测问题。");
  }
  const minimumCoverage = configuration.minimumCoverage ?? 0.8;
  if (!Number.isFinite(minimumCoverage) || minimumCoverage < 0.5 || minimumCoverage > 1) {
    throw new HttpError(400, "有效样本门槛须在 50% 到 100% 之间。");
  }
  const competitors = prepareCompetitors(configuration.competitors);
  const runs = questions.map((question) => prepareGeo({ ...configuration, question }, platforms));
  const input = { ...runs[0].input, questions, competitors, minimumCoverage };
  const steps = runs.flatMap((run, questionIndex) => run.steps.map((step) => ({
    ...step, input: { ...step.input, questionIndex },
  })));
  return { input, steps };
}

export async function saveMonitor(db, scope, body, prepare, id) {
  const { name, cadence, timeZone, active } = validateMonitor(body);
  if (!["geo", "seo"].includes(body.kind)) throw new HttpError(400, "无效的监测类型。");
  await prepare(body.kind, body.configuration);
  let row;
  if (id) {
    if (!isUuid(id)) throw new HttpError(404, "资源不存在。");
    ({ rows: [row] } = await db.query(`
      UPDATE yaosight.monitors SET name=$4,cadence=$5,time_zone=$6,active=$7,current_version=current_version+1,
        next_run_at=CASE WHEN $7 THEN
          CASE WHEN active AND cadence=$5 AND time_zone=$6 THEN next_run_at ELSE now() END
          ELSE NULL END
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND kind=$8 RETURNING id,current_version
    `, [...keysOf(scope), id, name, cadence, timeZone, active, body.kind]));
    if (!row) throw new HttpError(404, "资源不存在。");
  } else {
    ({ rows: [row] } = await db.query(`
      INSERT INTO yaosight.monitors(workspace_id,project_id,name,cadence,time_zone,active,kind,next_run_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6 THEN now() ELSE NULL END)
      RETURNING id,current_version
    `, [...keysOf(scope), name, cadence, timeZone, active, body.kind]));
  }
  await db.query(`
    INSERT INTO yaosight.monitor_versions(workspace_id,project_id,monitor_id,version,configuration)
    VALUES ($1,$2,$3,$4,$5)
  `, [...keysOf(scope), row.id, row.current_version, JSON.stringify(body.configuration)]);
  return row;
}

export async function readMonitor(db, scope, id) {
  if (!isUuid(id)) throw new HttpError(404, "资源不存在。");
  const { rows: [monitor] } = await db.query(`
    SELECT m.*,v.configuration FROM yaosight.monitors m
    JOIN yaosight.monitor_versions v
      ON (v.workspace_id,v.project_id,v.monitor_id,v.version)=(m.workspace_id,m.project_id,m.id,m.current_version)
    WHERE m.workspace_id=$1 AND m.project_id=$2 AND m.id=$3
  `, [...keysOf(scope), id]);
  if (!monitor) throw new HttpError(404, "资源不存在。");
  return monitor;
}

async function queueMonitor(db, monitor, prepare, key, slot = null) {
  const scope = { workspaceId: monitor.workspace_id, projectId: monitor.project_id };
  const prepared = await prepare(db, scope, monitor.kind, monitor.configuration);
  return enqueue(db, {
    ...scope, kind: monitor.kind, requestKey: key, ...prepared,
    input: { ...prepared.input, monitorId: monitor.id, questionSetVersion: monitor.current_version,
      monitorName: monitor.name, ...(slot && { scheduledSlot: slot.toISOString(), timeZone: monitor.time_zone }) },
  });
}

export async function runMonitor(db, scope, id, key, prepare) {
  const monitor = await readMonitor(db, scope, id);
  if (typeof key !== "string" || !/^[\w:-]{1,90}$/.test(key)) throw new HttpError(400, "缺少请求标识。");
  return queueMonitor(db, monitor, prepare, "monitor:" + monitor.id + ":" + key);
}

export async function dueMonitor(pool, prepare) {
  return inTransaction(pool, async (db) => {
    const { rows: [monitor] } = await db.query(`
      SELECT m.*,v.configuration FROM yaosight.monitors m
      JOIN yaosight.monitor_versions v
        ON (v.workspace_id,v.project_id,v.monitor_id,v.version)=(m.workspace_id,m.project_id,m.id,m.current_version)
      WHERE m.active AND m.next_run_at<=now() ORDER BY m.next_run_at FOR UPDATE OF m SKIP LOCKED LIMIT 1
    `);
    if (!monitor) return false;
    const keys = [monitor.workspace_id, monitor.project_id, monitor.id];
    const slot = monitor.next_run_at;
    let job;
    try { job = await queueMonitor(db, monitor, prepare, "scheduled:" + monitor.id + ":" + Math.floor(+slot / 1000), slot); }
    catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof GeoError)) throw error;
    }
    await db.query(`
      INSERT INTO yaosight.monitor_periods(workspace_id,project_id,monitor_id,slot,job_id,status)
      VALUES($1,$2,$3,$4,$5,$6)
    `, [...keys, slot, job?.id ?? null, job ? "queued" : "blocked"]);
    await db.query(`
      UPDATE yaosight.monitors
      SET next_run_at=((GREATEST(next_run_at,now()) AT TIME ZONE time_zone) +
        CASE cadence WHEN 'daily' THEN interval '1 day' ELSE interval '1 week' END) AT TIME ZONE time_zone
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, keys);
    return true;
  });
}
