import { resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { HttpError } from "./http.mjs";
import { secretToken } from "./workspaces.mjs";
import { seoDemo } from "./demo-seo.mjs";

export function siteHost(value) {
  const host = typeof value === "string" ? domainToASCII(value.trim().replace(/\.$/, "")).toLowerCase() : "";
  if (!host || host.length > 240 || isIP(host) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host) ||
      /\.(localhost|local|internal|test|invalid|onion)$/.test(host)) throw new HttpError(400, "请输入站点的完整公开域名。");
  return host;
}

export async function beginSiteVerification(db, scope, domain) {
  const host = siteHost(domain);
  const token = "yaosight-verification=" + secretToken();
  const { rows: [project] } = await db.query(`
    UPDATE yaosight.projects SET site_host=$3,site_challenge=$4,site_verified_at=NULL
    WHERE workspace_id=$1 AND id=$2 RETURNING site_host,site_challenge,site_verified_at
  `, [scope.workspaceId, scope.projectId, host, token]);
  return project;
}

export async function getSite(db, scope) {
  const { rows: [project] } = await db.query(`
    SELECT site_host,site_challenge,site_verified_at FROM yaosight.projects WHERE workspace_id=$1 AND id=$2
  `, [scope.workspaceId, scope.projectId]);
  if (!project) throw new HttpError(404, "资源不存在。");
  return project;
}

export async function verifySite(db, scope, site, lookup = resolveTxt) {
  if (!site.site_host || !site.site_challenge) throw new HttpError(409, "请先生成验证记录。");
  let records;
  try { records = await lookup("_yaosight." + site.site_host); }
  catch { throw new HttpError(422, "暂时没有查到 DNS TXT 记录。"); }
  if (!records.some((parts) => parts.join("") === site.site_challenge)) {
    throw new HttpError(422, "DNS TXT 记录与项目的验证值不符。");
  }
  const { rows: [verified] } = await db.query(`
    UPDATE yaosight.projects SET site_verified_at=now()
    WHERE workspace_id=$1 AND id=$2 AND site_host=$3 AND site_challenge=$4
    RETURNING site_host,site_challenge,site_verified_at
  `, [scope.workspaceId, scope.projectId, site.site_host, site.site_challenge]);
  if (!verified) throw new HttpError(409, "站点配置已改变，请重新验证。");
  return verified;
}

export function normalizeAudit(input) {
  let url;
  try { url = new URL(input?.url); }
  catch { throw new HttpError(400, "请输入站点入口的完整 URL。"); }
  const host = siteHost(url.hostname);
  if (url.username || url.password || url.port || url.search || !["http:", "https:"].includes(url.protocol)) {
    throw new HttpError(400, "仅支持无凭据、查询参数或自定义端口的 HTTP(S) 入口。");
  }
  url.hostname = host;
  url.hash = "";
  const path = input.path ?? "/";
  if (typeof path !== "string" || path.length > 512 || !/^\/(?:[a-zA-Z0-9._~-]+\/)*$/u.test(path) ||
      path.split("/").some((part) => part === "." || part === "..") || !url.pathname.startsWith(path)) {
    throw new HttpError(400, "抓取范围须包含入口，且以斜杠开头和结尾。");
  }
  const pages = input.pages ?? 40;
  const depth = input.depth ?? 3;
  const rate = input.rate ?? 2;
  if (!Number.isInteger(pages) || pages < 1 || pages > 100 || ![1, 2, 3, 4, 5].includes(depth) || ![1, 2].includes(rate)) {
    throw new HttpError(400, "审计限制超出允许范围。");
  }
  return { url: url.href, host, path, pages, depth, rate };
}

export async function prepareSeo(db, scope, target, { allowDemo = false } = {}) {
  if (target?.demo === true && allowDemo) {
    const input = seoDemo().config;
    return { input, steps: [{ category: "page_limit", estimate: 0, input }] };
  }
  const input = normalizeAudit(target);
  const site = await getSite(db, scope);
  if (site.site_host !== input.host || !site.site_verified_at ||
      Date.now() - +site.site_verified_at > 30 * 86400000) {
    throw new HttpError(409, "请先验证入口域名。");
  }
  return { input, steps: [{ category: "page_limit", estimate: input.pages, input }] };
}
