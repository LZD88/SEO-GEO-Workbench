import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localAuth } from "./local-auth.mjs";
import { GeoError } from "./geo-checks.mjs";
import { articleReportMarkdown, articleReportPath } from "./article-reports.mjs";
import { maintenanceAnnouncement } from "./local-maintenance.mjs";

const prefix = "/api/admin";
const sessionPaths = [prefix + "/session", prefix + "/login", prefix + "/logout"];
const defaults = { sampleCount: 1, webSearch: true };
const defaultSeoLimits = { workers: 2, rate: 2, pages: 100, queue: 150, depth: 3, timeout: 180000 };
const defaultMaintenance = { enabled: false, message: maintenanceAnnouncement, updatedAt: null };

async function readConfig(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

function normalizeSettings(value) {
  if (![1, 3, 5].includes(value?.sampleCount) || typeof value?.webSearch !== "boolean") return null;
  return { sampleCount: value.sampleCount, webSearch: value.webSearch };
}

function normalizeSeoLimits(value) {
  const limits = Object.fromEntries(Object.keys(defaultSeoLimits).map((key) => [key, value?.[key]]));
  const minimums = { workers: 1, rate: 1, pages: 1, queue: 1, depth: 1, timeout: 1000 };
  if (Object.keys(limits).some((key) =>
    !Number.isSafeInteger(limits[key]) || limits[key] < minimums[key] || limits[key] > defaultSeoLimits[key])) return null;
  return limits;
}

function normalizeMaintenance(value) {
  if (typeof value?.enabled !== "boolean" || typeof value.message !== "string" || value.message.trim().length > 240) return null;
  return { enabled: value.enabled, message: value.message.trim() || maintenanceAnnouncement };
}

export async function createLocalAdmin({ dataDir, checks, platforms, seoJobs, articleReports, download }) {
  const auth = await localAuth(join(dataDir, "admin-account.json"), { namespace: prefix, cookie: "yaosight_admin_session", allowSetup: false });
  const settingsFile = join(dataDir, "evaluation-settings.json");
  const maintenanceFile = join(dataDir, "maintenance.json");
  const stored = await readConfig(settingsFile);
  let settings = normalizeSettings(stored) ?? defaults;
  let seoLimits = normalizeSeoLimits(stored?.seoLimits) ?? defaultSeoLimits;
  const saved = await readConfig(maintenanceFile);
  const restored = normalizeMaintenance(saved);
  let maintenance = restored ? { ...restored, updatedAt: saved.updatedAt ?? null } : defaultMaintenance;
  let saving = Promise.resolve();

  // Serialize state changes so overlapping writes cannot drop a setting or revert the current status.
  function update(file, next, apply) {
    const save = saving.then(async () => {
      const value = next();
      await mkdir(dataDir, { recursive: true });
      const staging = file + "." + randomUUID() + ".tmp";
      await writeFile(staging, JSON.stringify(value), { mode: 0o600, flush: true });
      await rename(staging, file);
      return apply(value);
    });
    saving = save.catch(() => {});
    return save;
  }

  async function handle(req, res, path, input, json, origin) {
    if (sessionPaths.includes(path)) return auth.handle(req, res, path, input, json, origin);
    if (!auth.signedIn(req)) return json(res, 401, { error: "请先登录管理员后台。" });
    if (req.method === "POST" && [prefix + "/settings", prefix + "/seo-settings", prefix + "/maintenance"].includes(path)) {
      if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
        return json(res, 403, { error: "请求来源不符。" });
      }
      let payload;
      try { payload = await input(req); }
      catch { return json(res, 400, { error: "请求格式无效。" }); }
      if (path === prefix + "/maintenance") {
        const next = normalizeMaintenance(payload);
        if (!next) return json(res, 400, { error: "请输入有效的维护状态和公告，公告最多 240 字。" });
        const result = await update(maintenanceFile, () => ({ ...next, updatedAt: new Date().toISOString() }),
          (value) => (maintenance = value));
        return json(res, 200, result);
      }
      if (path === prefix + "/seo-settings") {
        const next = normalizeSeoLimits(payload);
        if (!next) return json(res, 400, { error: "抓取参数超出了允许范围。" });
        const result = await update(settingsFile, () => ({ ...settings, seoLimits: next }), (value) => (seoLimits = value.seoLimits));
        return json(res, 200, result);
      }
      const next = normalizeSettings(payload);
      if (!next) return json(res, 400, { error: "采样次数或联网策略无效。" });
      const result = await update(settingsFile, () => ({
        ...next, ...(seoLimits === defaultSeoLimits ? {} : { seoLimits }),
      }), () => (settings = next));
      return json(res, 200, result);
    }
    if (req.method !== "GET") return json(res, 405, { error: "不支持此请求。" });
    if (path === prefix + "/maintenance") return json(res, 200, maintenance);
    if (path === prefix + "/overview") {
      const channels = platforms.list().map((item) => {
        const { model, channelType } = platforms.configuration(item.id);
        return { ...item, model, channelType };
      });
      const [geo, articles] = await Promise.all([checks.list(), articleReports.list()]);
      return json(res, 200, { settings, seoLimits, maintenance, channels, geo, seo: seoJobs(), articles });
    }
    const check = /^\/api\/admin\/geo\/([a-f0-9-]{36}|[a-f0-9]{64})$/.exec(path);
    const articlePrefix = prefix + "/articles/";
    const article = path.startsWith(articlePrefix) && articleReportPath.exec("/api/article-reports/" + path.slice(articlePrefix.length));
    if (check || article) {
      try {
        if (check) return json(res, 200, await checks.diagnostics(check[1]));
        const report = await articleReports.read(article[1]);
        if (!article[2]) return json(res, 200, report);
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store",
          "Content-Disposition": 'attachment; filename="article-report-' + report.id.slice(0, 8) + '.md"',
        });
        return res.end(articleReportMarkdown(report));
      } catch (error) {
        if (error instanceof GeoError) return json(res, error.status, { error: error.message });
        throw error;
      }
    }
    const report = /^\/api\/admin\/reports\/([a-f0-9-]{36})\/(html|json|log)$/.exec(path);
    if (report) return download(res, report[1], report[2]);
    return json(res, 404, { error: "页面不存在。" });
  }

  function geoOptions(ids) {
    const selected = Array.isArray(ids) ? ids : [];
    const hasSearch = platforms.list().some((item) => selected.includes(item.id) && item.ready && item.search);
    return { sampleCount: settings.sampleCount, webSearch: settings.webSearch && hasSearch };
  }

  return { handle, geoOptions, get seoLimits() { return seoLimits; }, get maintenance() { return maintenance; } };
}
