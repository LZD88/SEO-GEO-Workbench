import { randomUUID } from "node:crypto";
import { inTransaction } from "./db.mjs";
import { HttpError, isUuid } from "./http.mjs";

const categories = ["model_limit", "page_limit", "source_limit"];
const kinds = ["geo", "seo", "article-source", "article-optimization"];
const keyOf = ({ workspace_id, project_id, id }) => [workspace_id, project_id, id];

const usageQuery = `
  SELECT category,
    COALESCE(sum(estimated_units) FILTER (WHERE state IN ('queued','running')),0)::int AS reserved,
    COALESCE(sum(estimated_units) FILTER (WHERE state='review'),0)::int AS awaiting_review,
    COALESCE(sum(actual_units),0)::int AS actual
  FROM yaosight.job_steps WHERE workspace_id=$1 GROUP BY category
`;

export async function usage(db, workspaceId) {
  const { rows } = await db.query(usageQuery, [workspaceId]);
  return rows;
}

export async function enqueue(db, { workspaceId, projectId, kind, requestKey, input, steps, baselineId = null }) {
  if (!kinds.includes(kind) || !/^[\w:-]{1,150}$/.test(requestKey ?? "") || !Array.isArray(steps) || !steps.length) {
    throw new HttpError(400, "任务参数不完整。");
  }
  if (steps.length > 300 || steps.some(({ category, estimate }) =>
    !categories.includes(category) || !Number.isInteger(estimate) || estimate < 0 || estimate > 10000)) {
    throw new HttpError(400, "任务超出单次规模限制。");
  }
  await db.query("INSERT INTO yaosight.workspace_limits (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING", [workspaceId]);
  const { rows: [limits] } = await db.query("SELECT * FROM yaosight.workspace_limits WHERE workspace_id=$1 FOR UPDATE", [workspaceId]);
  const values = [workspaceId, projectId, kind, requestKey, JSON.stringify(input), baselineId];
  const { rows: [existing] } = await db.query(`
    SELECT id, status, input=$5::jsonb AND baseline_id IS NOT DISTINCT FROM $6::uuid AS matches
    FROM yaosight.jobs WHERE workspace_id=$1 AND project_id=$2 AND kind=$3 AND request_key=$4
  `, values);
  if (existing) {
    if (!existing.matches) throw new HttpError(409, "该请求标识已用于不同的任务参数。");
    return { id: existing.id, status: existing.status };
  }
  const { rows: [project] } = await db.query(
    "SELECT paused_at FROM yaosight.projects WHERE workspace_id=$1 AND id=$2", values.slice(0, 2),
  );
  if (!project) throw new HttpError(404, "资源不存在。");
  if (project.paused_at) throw new HttpError(409, "项目已暂停。");

  const { rows: [active] } = await db.query(`
    SELECT count(*)::int AS count FROM yaosight.jobs WHERE workspace_id=$1 AND status IN ('queued','running')
  `, [workspaceId]);
  if (active.count >= limits.max_active) throw new HttpError(429, "当前工作空间任务已达并发上限。");

  const used = new Map((await usage(db, workspaceId)).map((row) => [
    row.category, row.reserved + row.awaiting_review + row.actual,
  ]));
  for (const category of categories) {
    const request = steps.filter((step) => step.category === category).reduce((total, step) => total + step.estimate, 0);
    if (request && (used.get(category) ?? 0) + request > limits[category]) throw new HttpError(429, "当前工作空间额度不足。");
  }
  const { rows: [job] } = await db.query(`
    INSERT INTO yaosight.jobs (workspace_id,project_id,kind,request_key,input,baseline_id)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status
  `, values);
  await db.query(`
    INSERT INTO yaosight.job_steps (workspace_id,project_id,job_id,step_index,channel,input,category,estimated_units,state,result,actual_units)
    SELECT $1,$2,$3,r.ordinality-1,r.value->>'channel',r.value->'input',r.value->>'category',
      (r.value->>'estimate')::int,
      CASE WHEN r.value ? 'prior' THEN 'succeeded' ELSE 'queued' END,
      r.value->'prior', CASE WHEN r.value ? 'prior' THEN 0 ELSE NULL END
    FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS r(value,ordinality)
  `, [workspaceId, projectId, job.id, JSON.stringify(steps)]);
  return job;
}

export async function claim(pool, leaseSeconds = 30) {
  return inTransaction(pool, async (db) => {
    const { rows: [job] } = await db.query(`
      SELECT j.* FROM yaosight.jobs j JOIN yaosight.projects p ON p.workspace_id=j.workspace_id AND p.id=j.project_id
      WHERE (j.status='queued' AND j.ready_at<=now() AND p.paused_at IS NULL)
        OR (j.status='running' AND j.leased_until<=now())
      ORDER BY j.ready_at, j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
    `);
    if (!job) return null;
    const ids = keyOf(job);
    if (job.status === "running") {
      await db.query(`
        UPDATE yaosight.job_steps SET state='review', error_category='lease_expired'
        WHERE workspace_id=$1 AND project_id=$2 AND job_id=$3 AND state='running'
      `, ids);
    }
    const leaseToken = randomUUID();
    const { rows: [leased] } = await db.query(`
      UPDATE yaosight.jobs SET status='running', lease_token=$4, leased_until=now()+make_interval(secs=>$5),
        first_claimed_at=COALESCE(first_claimed_at,now())
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 RETURNING *
    `, [...ids, leaseToken, leaseSeconds]);
    return leased;
  });
}

export async function heartbeat(pool, job, leaseSeconds) {
  const { rowCount } = await pool.query(`
    UPDATE yaosight.jobs SET leased_until=now()+make_interval(secs=>$5)
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND lease_token=$4 AND leased_until>now()
  `, [...keyOf(job), job.lease_token, leaseSeconds]);
  return rowCount === 1;
}

async function lockLease(db, job) {
  const { rows: [current] } = await db.query(`
    SELECT j.cancel_requested_at, p.paused_at FROM yaosight.jobs j
    JOIN yaosight.projects p ON p.workspace_id=j.workspace_id AND p.id=j.project_id
    WHERE j.workspace_id=$1 AND j.project_id=$2 AND j.id=$3 AND j.lease_token=$4 AND j.leased_until>now()
    FOR UPDATE OF j
  `, [...keyOf(job), job.lease_token]);
  return current;
}

async function releaseLease(db, job, state) {
  await db.query(`
    UPDATE yaosight.jobs SET status=$4, lease_token=NULL, leased_until=NULL, ready_at=COALESCE($5,now()),
      finished_at=CASE WHEN $4='queued' THEN NULL ELSE now() END
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, [...keyOf(job), state.status, state.readyAt ?? null]);
}

function terminalState(states, canceled) {
  if (canceled) return "canceled";
  if (states.includes("review")) return "review";
  if (!states.includes("succeeded")) return "failed";
  return states.every((state) => state === "succeeded") ? "succeeded" : "partial";
}

export function takeStep(pool, job) {
  return inTransaction(pool, async (db) => {
    const lease = await lockLease(db, job);
    if (!lease) return null;
    const ids = keyOf(job);
    if (lease.cancel_requested_at) {
      await db.query(`
        UPDATE yaosight.job_steps SET state='canceled',actual_units=0,finished_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND job_id=$3 AND state='queued'
      `, ids);
    }
    const { rows: [next] } = await db.query(`
      SELECT s.* FROM yaosight.job_steps s LEFT JOIN yaosight.paused_channels p ON p.id=s.channel
      WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.job_id=$3 AND s.state='queued'
        AND s.ready_at<=now() AND p.id IS NULL ORDER BY s.step_index LIMIT 1
    `, ids);
    if (next && !lease.paused_at) {
      const { rows: [step] } = await db.query(`
        UPDATE yaosight.job_steps SET state='running', attempts=attempts+1
        WHERE workspace_id=$1 AND project_id=$2 AND job_id=$3 AND step_index=$4 RETURNING *
      `, [...ids, next.step_index]);
      return step;
    }
    const { rows } = await db.query(`
      SELECT state,ready_at FROM yaosight.job_steps WHERE workspace_id=$1 AND project_id=$2 AND job_id=$3
    `, ids);
    const queued = rows.filter((row) => row.state === "queued");
    if (queued.length > 0) {
      // Wait for rate-limit backoff or an operator to resume a channel.
      const readyAt = new Date(Math.max(Date.now() + 5000, Math.min(...queued.map((row) => +row.ready_at))));
      await releaseLease(db, job, { status: "queued", readyAt });
    } else {
      await releaseLease(db, job, { status: terminalState(rows.map((row) => row.state), lease.cancel_requested_at) });
    }
    return null;
  });
}

export function finishStep(pool, job, step, outcome) {
  return inTransaction(pool, async (db) => {
    if (!(await lockLease(db, job))) return false;
    if (!["succeeded", "failed", "review", "queued"].includes(outcome.state)) throw new Error("Invalid step outcome");
    const retrySeconds = outcome.state === "queued" ? Math.min(60, 5 * 2 ** step.attempts) : 0;
    const { rowCount } = await db.query(`
      UPDATE yaosight.job_steps SET state=$5, actual_units=$6, error_category=$7,
        result=$8, ready_at=now()+make_interval(secs=>$9),
        finished_at=CASE WHEN $5='queued' THEN NULL ELSE now() END
      WHERE workspace_id=$1 AND project_id=$2 AND job_id=$3 AND step_index=$4 AND state='running'
    `, [...keyOf(job), step.step_index, outcome.state, outcome.units ?? null, outcome.category ?? null,
      outcome.result === undefined ? null : JSON.stringify(outcome.result), retrySeconds]);
    return rowCount === 1;
  });
}

export async function getJob(db, { workspaceId, projectId, jobId, includeStepInputs = false }) {
  if (!isUuid(jobId)) throw new HttpError(404, "资源不存在。");
  const params = [workspaceId, projectId, jobId];
  const { rows: [job] } = await db.query(`
    SELECT id,kind,input,status,baseline_id,created_at,finished_at,cancel_requested_at
    FROM yaosight.jobs WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, params);
  if (!job) throw new HttpError(404, "资源不存在。");
  const { rows: steps } = await db.query(`
    SELECT step_index,channel,state,result,error_category,estimated_units,actual_units,finished_at
      ${includeStepInputs ? ", input" : ""}
    FROM yaosight.job_steps WHERE workspace_id=$1 AND project_id=$2 AND job_id=$3 ORDER BY step_index
  `, params);
  return { ...job, steps };
}

export async function cancelJob(db, scope) {
  const params = [scope.workspaceId, scope.projectId, scope.jobId];
  const job = await getJob(db, scope);
  if (!["queued", "running"].includes(job.status)) return { status: job.status };
  const { rows: [canceled] } = await db.query(`
    UPDATE yaosight.jobs SET cancel_requested_at=now(),
      status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,
      finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND status IN ('queued','running') RETURNING status
  `, params);
  if (canceled?.status === "canceled") {
    await db.query(`
      UPDATE yaosight.job_steps SET state='canceled',actual_units=0,finished_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND job_id=$3 AND state='queued'
    `, params);
  }
  return { status: canceled?.status ?? (await getJob(db, scope)).status };
}
