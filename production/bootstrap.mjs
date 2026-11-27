import { createPool } from "./db.mjs";
import { bootstrapWorkspace } from "./workspaces.mjs";

const [, , name, email] = process.argv;
if (!name || !email) throw new Error("Usage: node production/bootstrap.mjs \"Workspace Name\" owner@example.com");
const origin = new URL(process.env.PUBLIC_ORIGIN);
if (origin.protocol !== "https:") throw new Error("PUBLIC_ORIGIN must use HTTPS");
const pool = createPool(process.env.DATABASE_URL);
try {
  const workspace = await bootstrapWorkspace(pool, name, email);
  const invite = new URL("/auth/login", origin);
  invite.searchParams.set("invite", workspace.token);
  console.log("Workspace: " + workspace.id);
  console.log("One-time owner invitation: " + invite.href);
} finally {
  await pool.end();
}
