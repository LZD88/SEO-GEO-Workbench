import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool, inTransaction } from "./db.mjs";

const directory = new URL("./migrations/", import.meta.url);

export async function migrate(pool, appRole) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole ?? "")) throw new Error("Invalid DATABASE_APP_ROLE");
  const files = (await readdir(directory)).filter((file) => /^\d{3}-[a-z-]+\.sql$/.test(file)).sort();
  if (!files.length) throw new Error("Migration files are missing");

  return inTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(1474004133)");
    const { rows: [migrationRole] } = await db.query("SELECT current_user AS name");
    if (appRole === migrationRole.name) throw new Error("The schema owner and application roles must be distinct");
    const { rows: [role] } = await db.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1", [appRole],
    );
    if (!role || Object.values(role).some(Boolean)) throw new Error("Create a least-privilege application role before migrating");
    const { rows: [membership] } = await db.query("SELECT pg_has_role($1, current_user, 'MEMBER') AS inherited", [appRole]);
    if (membership.inherited) throw new Error("The application role must not inherit schema-owner privileges");
    await db.query(`
      CREATE SCHEMA IF NOT EXISTS yaosight;
      CREATE TABLE IF NOT EXISTS yaosight.schema_migrations (
        version integer PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const { rows } = await db.query("SELECT version, sha256 FROM yaosight.schema_migrations ORDER BY version");
    const applied = new Map(rows.map(({ version, sha256 }) => [version, sha256]));
    let version = 0;
    for (const file of files) {
      const next = Number(file.slice(0, 3));
      if (next !== version + 1) throw new Error("Migrations must be numbered consecutively");
      version = next;
      const source = (await readFile(new URL(file, directory), "utf8")).replaceAll("\r\n", "\n");
      const digest = createHash("sha256").update(source).digest("hex");
      if (applied.has(version)) {
        if (applied.get(version) !== digest) throw new Error("Applied migration was modified: " + file);
      } else {
        await db.query(source);
        await db.query("INSERT INTO yaosight.schema_migrations (version, sha256) VALUES ($1, $2)", [version, digest]);
      }
    }
    if (applied.size > files.length) throw new Error("Database has newer migrations");
    await db.query(`
      REVOKE ALL ON SCHEMA yaosight FROM PUBLIC;
      GRANT USAGE ON SCHEMA yaosight TO "${appRole}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA yaosight TO "${appRole}";
      REVOKE INSERT, UPDATE, DELETE ON yaosight.schema_migrations FROM "${appRole}";
      REVOKE UPDATE, DELETE ON yaosight.audit_events FROM "${appRole}";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA yaosight TO "${appRole}";
    `);
    return version;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(process.env.MIGRATION_DATABASE_URL);
  try {
    const version = await migrate(pool, process.env.DATABASE_APP_ROLE);
    console.log("Database schema version " + version);
  } finally {
    await pool.end();
  }
}
