import { createHash, randomBytes } from "node:crypto";
import { inTransaction } from "./db.mjs";
import { HttpError, isUuid, nameField } from "./http.mjs";

export const secretToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (value) => createHash("sha256").update(value).digest("hex");
export const isSecretToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const roles = ["owner", "editor", "viewer"];

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new HttpError(400, "邮箱地址无效。");
  return email;
}

async function audit(db, workspaceId, actorId, action, target, result = "success") {
  await db.query(
    "INSERT INTO yaosight.audit_events (workspace_id, actor_id, action, target, result) VALUES ($1,$2,$3,$4,$5)",
    [workspaceId, actorId, action, target, result],
  );
}

export async function requireWorkspace(db, userId, workspaceId, requested = "viewer", { write = false } = {}) {
  if (!isUuid(workspaceId)) throw new HttpError(404, "资源不存在。");
  const { rows: [membership] } = await db.query(`
    SELECT role FROM yaosight.members WHERE workspace_id = $1 AND account_id = $2
    ${write ? "FOR SHARE" : ""}
  `, [workspaceId, userId]);
  if (!membership) throw new HttpError(404, "资源不存在。");
  if (roles.indexOf(membership.role) > roles.indexOf(requested)) throw new HttpError(403, "权限不足。");
  return membership.role;
}

export async function requireProject(db, userId, workspaceId, projectId, requested = "viewer", options = {}) {
  const role = await requireWorkspace(db, userId, workspaceId, requested, options);
  if (!isUuid(projectId)) throw new HttpError(404, "资源不存在。");
  const { rows: [project] } = await db.query(
    "SELECT id, name FROM yaosight.projects WHERE workspace_id = $1 AND id = $2",
    [workspaceId, projectId],
  );
  if (!project) throw new HttpError(404, "资源不存在。");
  return { ...project, role };
}

async function issueInvitation(db, workspaceId, actorId, email, role) {
  const token = secretToken();
  await db.query(`
    INSERT INTO yaosight.invitations (token_hash, workspace_id, email, role, created_by, expires_at)
    VALUES ($1, $2, $3, $4, $5, now() + interval '2 days')
  `, [tokenHash(token), workspaceId, normalizeEmail(email), role, actorId]);
  await audit(db, workspaceId, actorId, "member.invited", normalizeEmail(email));
  return token;
}

export function bootstrapWorkspace(pool, name, email) {
  return inTransaction(pool, async (db) => {
    const { rows: [workspace] } = await db.query(
      "INSERT INTO yaosight.workspaces (name) VALUES ($1) RETURNING id, name", [nameField(name)],
    );
    const token = await issueInvitation(db, workspace.id, null, email, "owner");
    return { ...workspace, token };
  });
}

export function inviteMember(pool, actorId, workspaceId, email, role) {
  if (!roles.includes(role)) throw new HttpError(400, "无效的成员角色。");
  return inTransaction(pool, async (db) => {
    await requireWorkspace(db, actorId, workspaceId, "owner", { write: true });
    return issueInvitation(db, workspaceId, actorId, email, role);
  });
}

export function changeMember(pool, actorId, workspaceId, memberId, role) {
  if (!isUuid(memberId)) throw new HttpError(404, "资源不存在。");
  if (role !== null && !roles.includes(role)) throw new HttpError(400, "无效的成员角色。");
  return inTransaction(pool, async (db) => {
    // Serialize ownership changes in one space, including attempts to remove the last owner.
    if (!isUuid(workspaceId)) throw new HttpError(404, "资源不存在。");
    await requireWorkspace(db, actorId, workspaceId, "owner");
    await db.query("SELECT id FROM yaosight.workspaces WHERE id=$1 FOR NO KEY UPDATE", [workspaceId]);
    await requireWorkspace(db, actorId, workspaceId, "owner", { write: true });
    const { rows: [member] } = await db.query(
      "SELECT role FROM yaosight.members WHERE workspace_id=$1 AND account_id=$2", [workspaceId, memberId],
    );
    if (!member) throw new HttpError(404, "成员不存在。");
    if (member.role === "owner" && role !== "owner") {
      const { rows: [other] } = await db.query(
        "SELECT 1 FROM yaosight.members WHERE workspace_id=$1 AND role='owner' AND account_id!=$2 LIMIT 1",
        [workspaceId, memberId],
      );
      if (!other) throw new HttpError(409, "工作空间至少需要一位所有者。");
    }
    if (role === null) {
      await db.query("DELETE FROM yaosight.members WHERE workspace_id=$1 AND account_id=$2", [workspaceId, memberId]);
    } else {
      await db.query("UPDATE yaosight.members SET role=$3 WHERE workspace_id=$1 AND account_id=$2", [workspaceId, memberId, role]);
    }
    await audit(db, workspaceId, actorId, role === null ? "member.removed" : "member.role." + role, memberId);
  });
}

export function createSession(pool, identity, invitationHash) {
  return inTransaction(pool, async (db) => {
    const email = normalizeEmail(identity.email);
    const { rows: [account] } = await db.query(`
      INSERT INTO yaosight.accounts (issuer, subject, email) VALUES ($1, $2, $3)
      ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email RETURNING id
    `, [identity.issuer, identity.subject, email]);
    if (invitationHash) {
      const { rows: [invitation] } = await db.query(`
        UPDATE yaosight.invitations SET consumed_at = now()
        WHERE token_hash=$1 AND email=$2 AND expires_at>now() AND consumed_at IS NULL
        RETURNING workspace_id, role
      `, [invitationHash, email]);
      if (!invitation) throw new HttpError(403, "邀请无效、已过期，或当前登录邮箱与邀请不符。");
      await db.query(`
        INSERT INTO yaosight.members (workspace_id, account_id, role) VALUES ($1, $2, $3)
        ON CONFLICT (workspace_id, account_id) DO NOTHING
      `, [invitation.workspace_id, account.id, invitation.role]);
      await audit(db, invitation.workspace_id, account.id, "member.accepted", account.id);
    }
    const { rowCount } = await db.query("SELECT 1 FROM yaosight.members WHERE account_id=$1 LIMIT 1", [account.id]);
    if (rowCount === 0) throw new HttpError(403, "请使用团队邀请链接登录。");
    const session = secretToken();
    await db.query(`
      INSERT INTO yaosight.sessions (token_hash, account_id, expires_at)
      VALUES ($1, $2, now() + interval '8 hours')
    `, [tokenHash(session), account.id]);
    return session;
  });
}
