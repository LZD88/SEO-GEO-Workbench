import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { inTransaction } from "./db.mjs";
import { createAuth } from "./auth.mjs";
import { GeoError } from "../geo-checks.mjs";
import { createProjectRoutes } from "./project-routes.mjs";
import { HttpError, nameField, readJson, requireSameOrigin, sendJson } from "./http.mjs";
import { changeMember, inviteMember, requireProject, requireWorkspace } from "./workspaces.mjs";

const publicAssets = new Map([
  ["/", ["workspace.html", "text/html; charset=utf-8"]],
  ["/workspace.css", ["workspace.css", "text/css; charset=utf-8"]],
  ["/workspace.js", ["workspace.js", "text/javascript; charset=utf-8"]],
]);

export function createProductionServer({ pool, origin, settings, readiness, platforms, artifacts, sourceReady }) {
  const auth = createAuth({ pool, origin, settings });
  const projectRoutes = createProjectRoutes({ pool, platforms, artifacts, sourceReady });

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    if (url.origin !== origin.origin) throw new HttpError(400, "请求地址无效。");
    const path = url.pathname;
    if (req.method === "GET" && path === "/healthz") {
      const healthy = await readiness();
      return sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "unavailable" });
    }
    if (req.method === "GET" && publicAssets.has(path)) {
      const [file, contentType] = publicAssets.get(path);
      const data = await readFile(new URL("./public/" + file, import.meta.url));
      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      return res.end(data);
    }
    if (req.method === "GET" && path === "/auth/login") return auth.begin(req, res, url);
    if (req.method === "GET" && path === "/auth/callback") return auth.complete(req, res, url);
    if (!path.startsWith("/api/") && path !== "/auth/logout") throw new HttpError(404, "资源不存在。");
    if (req.method !== "GET" && req.method !== "HEAD") requireSameOrigin(req, origin);
    const user = await auth.session(req);
    if (!user) throw new HttpError(401, "请先登录。");
    if (req.method === "POST" && path === "/auth/logout") return auth.logout(req, res);
    if (req.method === "GET" && path === "/api/me") return sendJson(res, 200, { email: user.email });

    if (req.method === "GET" && path === "/api/workspaces") {
      const { rows } = await pool.query(`
        SELECT w.id, w.name, m.role FROM yaosight.members m JOIN yaosight.workspaces w ON w.id=m.workspace_id
        WHERE m.account_id=$1 ORDER BY w.id LIMIT 100
      `, [user.id]);
      return sendJson(res, 200, rows);
    }
    const [, api, spaceSegment, workspaceId, section, item, action, ...rest] = path.split("/");
    if (api !== "api" || spaceSegment !== "workspaces" || !workspaceId) throw new HttpError(404, "资源不存在。");

    if (section === "projects" && !item && req.method === "GET") {
      await requireWorkspace(pool, user.id, workspaceId);
      const { rows } = await pool.query(
        "SELECT id, name FROM yaosight.projects WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100", [workspaceId],
      );
      return sendJson(res, 200, rows);
    }
    if (section === "projects" && !item && req.method === "POST") {
      const payload = await readJson(req);
      const project = await inTransaction(pool, async (db) => {
        await requireWorkspace(db, user.id, workspaceId, "editor", { write: true });
        const { rows: [created] } = await db.query(
          "INSERT INTO yaosight.projects (workspace_id, name) VALUES ($1,$2) RETURNING id, name",
          [workspaceId, nameField(payload.name)],
        );
        return created;
      });
      return sendJson(res, 201, project);
    }
    if (section === "projects" && item) {
      if (action) return projectRoutes(req, res, url, user.id, { workspaceId, projectId: item }, [action, ...rest]);
      if (req.method === "GET") return sendJson(res, 200, await requireProject(pool, user.id, workspaceId, item));
    }
    if (section === "invitations" && !item && req.method === "POST") {
      const { email, role } = await readJson(req);
      const token = await inviteMember(pool, user.id, workspaceId, email, role);
      const link = new URL("/auth/login", origin);
      link.searchParams.set("invite", token);
      return sendJson(res, 201, { link: link.href });
    }
    if (section === "members" && !item && req.method === "GET") {
      await requireWorkspace(pool, user.id, workspaceId, "owner");
      const { rows } = await pool.query(`
        SELECT a.id, a.email, m.role FROM yaosight.members m JOIN yaosight.accounts a ON a.id=m.account_id
        WHERE m.workspace_id=$1 ORDER BY a.email LIMIT 100
      `, [workspaceId]);
      return sendJson(res, 200, rows);
    }
    if (section === "members" && item && !action && ["PATCH", "DELETE"].includes(req.method)) {
      const role = req.method === "DELETE" ? null : (await readJson(req)).role;
      if (req.method === "PATCH" && role === null) throw new HttpError(400, "无效的成员角色。");
      await changeMember(pool, user.id, workspaceId, item, role);
      return sendJson(res, 200, { status: "ok" });
    }
    if (section === "audit-events" && !item && req.method === "GET") {
      await requireWorkspace(pool, user.id, workspaceId, "owner");
      const { rows } = await pool.query(`
        SELECT actor_id, action, target, result, created_at FROM yaosight.audit_events
        WHERE workspace_id=$1 ORDER BY id DESC LIMIT 100
      `, [workspaceId]);
      return sendJson(res, 200, rows);
    }
    throw new HttpError(404, "资源不存在。");
  }

  return createServer({ requestTimeout: 30000, maxHeaderSize: 16384 }, (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    void handle(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError || error instanceof GeoError) return sendJson(res, error.status, { error: error.message });
      console.error(JSON.stringify({ event: "request_failed", category: "internal" }));
      return sendJson(res, 500, { error: "服务暂时不可用。" });
    });
  });
}
