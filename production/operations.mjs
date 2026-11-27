import { inTransaction } from "./db.mjs";
import { HttpError, isUuid } from "./http.mjs";

const channels = ["doubao", "qwen", "gpt", "gemini", "deepseek", "wenxin"];

export async function setChannelPaused(db, channel, paused) {
  if (!channels.includes(channel)) throw new HttpError(400, "无效的渠道。");
  if (paused) {
    await db.query("INSERT INTO yaosight.paused_channels (id) VALUES ($1) ON CONFLICT DO NOTHING", [channel]);
  } else {
    await db.query("DELETE FROM yaosight.paused_channels WHERE id=$1", [channel]);
  }
  return { channel, paused };
}

export function setProjectPaused(pool, workspaceId, projectId, paused) {
  if (!isUuid(workspaceId) || !isUuid(projectId)) throw new HttpError(400, "无效的项目。");
  return inTransaction(pool, async (db) => {
    const { rowCount } = await db.query(`
      UPDATE yaosight.projects SET paused_at=CASE WHEN $3 THEN now() ELSE NULL END
      WHERE workspace_id=$1 AND id=$2
    `, [workspaceId, projectId, paused]);
    if (rowCount !== 1) throw new HttpError(404, "项目不存在。");
    await db.query(`
      INSERT INTO yaosight.audit_events(workspace_id,action,target,result)
      VALUES ($1,$2,$3,'success')
    `, [workspaceId, paused ? "project.paused" : "project.resumed", projectId]);
    return { projectId, paused };
  });
}

export function setWorkspaceLimits(pool, workspaceId, options) {
  const limits = [options.model, options.pages, options.articles, options.active];
  if (!isUuid(workspaceId) || limits.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1000000) ||
      options.active < 1 || options.active > 100) throw new HttpError(400, "无效的工作空间或额度。");
  return inTransaction(pool, async (db) => {
    await db.query(`
      INSERT INTO yaosight.workspace_limits(workspace_id,model_limit,page_limit,source_limit,max_active)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (workspace_id) DO UPDATE SET model_limit=EXCLUDED.model_limit, page_limit=EXCLUDED.page_limit,
        source_limit=EXCLUDED.source_limit,max_active=EXCLUDED.max_active
    `, [workspaceId, ...limits]);
    await db.query(`
      INSERT INTO yaosight.audit_events(workspace_id,action,target,result)
      VALUES ($1,'workspace.limits',$2,'success')
    `, [workspaceId, JSON.stringify(options)]);
    return { workspaceId, ...options };
  });
}

export async function operationalStatus(pool) {
  const [{ rows: queues }, { rows: paused }, { rows: failures }, { rows: usage }, { rows: latency }] = await Promise.all([
    pool.query(`
      SELECT kind,status,count(*)::int AS count,
        max(extract(epoch FROM now()-created_at)) FILTER (WHERE status='queued')::int AS oldest_queue_seconds
      FROM yaosight.jobs GROUP BY kind,status ORDER BY kind,status
    `),
    pool.query("SELECT id,paused_at FROM yaosight.paused_channels ORDER BY id"),
    pool.query(`
      SELECT channel,error_category,count(*)::int AS count FROM yaosight.job_steps
      WHERE error_category IS NOT NULL AND (state='review' OR finished_at>now()-interval '24 hours')
      GROUP BY channel,error_category ORDER BY channel,error_category
    `),
    pool.query(`
      SELECT category, COALESCE(sum(actual_units),0)::int AS actual,
        COALESCE(sum(estimated_units) FILTER (WHERE state='review'),0)::int AS awaiting_review
      FROM yaosight.job_steps GROUP BY category ORDER BY category
    `),
    pool.query(`
      SELECT kind,count(*)::int AS observed,round(percentile_cont(0.95)
        WITHIN GROUP (ORDER BY extract(epoch FROM first_claimed_at-created_at))::numeric,2) AS p95_seconds
      FROM yaosight.jobs WHERE first_claimed_at>now()-interval '24 hours' GROUP BY kind ORDER BY kind
    `),
  ]);
  return { queues, paused, failures, usage, latency };
}
