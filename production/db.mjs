import pg from "pg";

export function createPool(connectionString) {
  if (!connectionString) throw new Error("A database connection URL is required");
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
}

export async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch { /* The original failure describes the transaction outcome. */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseVersion(pool) {
  const { rows: [row] } = await pool.query("SELECT COALESCE(max(version), 0) AS version FROM yaosight.schema_migrations");
  return row.version;
}
