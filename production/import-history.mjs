import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createPool, inTransaction } from "./db.mjs";
import { isUuid } from "./http.mjs";
import { requireProject } from "./workspaces.mjs";

const kinds = ["geo", "seo", "article-optimization"];
const sourceId = /^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/i;

function itemKey({ kind, id }) { return kind + ":" + id; }

function priorStatus(record) {
  const input = record.state ?? record.status;
  if (["done", "completed", "succeeded"].includes(input) || (record.generatedAt && typeof record.markdown === "string")) return "succeeded";
  if (["error", "failed"].includes(input)) return "failed";
  if (["aborted", "canceled"].includes(input)) return "canceled";
  return "review";
}

export async function importRecords(pool, scope, actor, records) {
  if (!Array.isArray(records) || !records.length || records.length > 1000 ||
      records.some((item) => !kinds.includes(item?.kind) || !sourceId.test(item.id) ||
        !item.record || typeof item.record !== "object" || Array.isArray(item.record))) {
    throw new Error("Import expects 1–1000 records with supported kind, source ID and record object");
  }
  if (new Set(records.map(itemKey)).size !== records.length) throw new Error("Import contains repeated source IDs");

  return inTransaction(pool, async (db) => {
    const { workspaceId, projectId } = scope;
    await requireProject(db, actor, workspaceId, projectId, "owner", { write: true });
    await db.query("SELECT id FROM yaosight.projects WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE", [workspaceId, projectId]);
    const { rows } = await db.query(`
      SELECT source_kind,source_id,job_id FROM yaosight.legacy_imports WHERE workspace_id=$1 AND project_id=$2
    `, [workspaceId, projectId]);
    const mapping = new Map(rows.map((row) => [row.source_kind + ":" + row.source_id, row.job_id]));
    let imported = 0;
    for (const item of records) {
      const key = itemKey(item);
      if (mapping.has(key)) continue;
      const record = item.record;
      const timestamp = new Date(record.createdAt ?? record.generatedAt);
      const firstSeen = Number.isFinite(+timestamp) ? timestamp : null;
      const prior = priorStatus(record);
      const result = item.kind === "article-optimization" ? {
        title: record.title, markdown: record.markdown, platform: record.platform, model: record.model,
        generatedAt: record.generatedAt,
      } : null;
      const input = item.kind === "geo" ? {
        kind: record.kind, name: record.name, url: record.url, question: record.question,
        historical: true, historicalState: prior === "review" ? "interrupted_or_unknown" : prior,
        legacyId: item.id, sampleCount: record.sampleCount, legacyConfiguration: record.configuration,
      } : {
        name: record.title ?? record.url ?? item.kind,
        url: record.url, historical: true, historicalState: prior === "review" ? "interrupted_or_unknown" : prior, legacyId: item.id,
      };
      const requestKey = "historical:" + createHash("sha256").update(key).digest("hex");
      const { rows: [job] } = await db.query(`
        INSERT INTO yaosight.jobs(workspace_id,project_id,kind,request_key,input,status,created_at,finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()),$7) RETURNING id
      `, [workspaceId, projectId, item.kind, requestKey, JSON.stringify(input), prior, firstSeen]);
      await db.query(`
        INSERT INTO yaosight.legacy_imports(workspace_id,project_id,source_kind,source_id,job_id)
        VALUES ($1,$2,$3,$4,$5)
      `, [workspaceId, projectId, item.kind, item.id, job.id]);
      const evidences = item.kind === "geo" && Array.isArray(record.samples) ? record.samples.slice(0, 300) : result ? [result] : [];
      for (const [index, sample] of evidences.entries()) {
        if (!sample || typeof sample !== "object") continue;
        const state = sample.pending ? "review" : sample.error ? "failed" : "succeeded";
        await db.query(`
          INSERT INTO yaosight.job_steps(workspace_id,project_id,job_id,step_index,channel,input,category,
            estimated_units,actual_units,state,result,finished_at)
          VALUES ($1,$2,$3,$4,$5,'{}','model_limit',0,0,$6,$7,$8)
        `, [workspaceId, projectId, job.id, index, sample.platformId ?? null, state, JSON.stringify(sample), firstSeen]);
      }
      mapping.set(key, job.id);
      imported++;
    }
    // A previous import may have arrived before its baseline. Fill only null associations.
    for (const item of records) {
      const relativeId = item.record.baselineId ?? item.record.checkId;
      const parent = mapping.get("geo:" + relativeId);
      const job = mapping.get(itemKey(item));
      if (parent && parent !== job) {
        await db.query(`
          UPDATE yaosight.jobs SET baseline_id=$4
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND baseline_id IS NULL
        `, [workspaceId, projectId, job, parent]);
      }
    }
    await db.query(`
      INSERT INTO yaosight.audit_events(workspace_id,actor_id,action,target,result)
      VALUES($1,$2,'history.imported',$3,'success')
    `, [workspaceId, actor, projectId]);
    return { imported, previouslyImported: records.length - imported };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [workspaceId, projectId, actor, manifest] = process.argv.slice(2);
  if (![workspaceId, projectId, actor].every(isUuid) || !manifest || (await stat(manifest)).size > 20 * 1024 * 1024) {
    throw new Error("Usage: import-history.mjs WORKSPACE PROJECT OWNER_ACCOUNT MANIFEST.json (limit 20 MB)");
  }
  const parsed = JSON.parse(await readFile(manifest, "utf8"));
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const result = await importRecords(pool, { workspaceId, projectId }, actor, parsed);
    console.log(JSON.stringify({ manifest: basename(manifest), ...result }));
  } finally { await pool.end(); }
}
