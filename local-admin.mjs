import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localAuth } from "./local-auth.mjs";
import { GeoError } from "./geo-checks.mjs";

const prefix = "/api/admin";
const sessionPaths = [prefix + "/session", prefix + "/login", prefix + "/logout"];
const initial = { sampleCount: 1, webSearch: true };
export const localSeoLimits = Object.freeze({ workers: 2, rate: 2, pages: 100, queue: 150, depth: 3, timeout: 180000 });

function validSettings(value) {
  return [1, 3, 5].includes(value?.sampleCount) && typeof value?.webSearch === "boolean";
}

export async function createLocalAdmin({ dataDir, checks, platforms, seoJobs, download }) {
  const auth = await localAuth(join(dataDir, "admin-account.json"), { namespace: prefix, cookie: "yaosight_admin_session", allowSetup: false });
  const file = join(dataDir, "evaluation-settings.json");
  let settings = initial;
  try {
    const stored = JSON.parse(await readFile(file, "utf8"));
    if (validSettings(stored)) settings = { sampleCount: stored.sampleCount, webSearch: stored.webSearch };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  async function handle(req, res, path, input, json, origin) {
    if (sessionPaths.includes(path)) return auth.handle(req, res, path, input, json, origin);
    if (!auth.signedIn(req)) return json(res, 401, { error: "请先登录管理员后台。" });
    if (path === prefix + "/settings" && req.method === "POST") {
      if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
        return json(res, 403, { error: "请求来源不符。" });
      }
      let payload;
      try { payload = await input(req); }
      catch { return json(res, 400, { error: "请求格式无效。" }); }
      if (!validSettings(payload)) return json(res, 400, { error: "采样次数或联网策略无效。" });
      const next = { sampleCount: payload.sampleCount, webSearch: payload.webSearch };
      await mkdir(dataDir, { recursive: true });
      const staging = file + "." + randomUUID() + ".tmp";
      await writeFile(staging, JSON.stringify(next), { mode: 0o600 });
      await rename(staging, file);
      settings = next;
      return json(res, 200, settings);
    }
    if (req.method !== "GET") return json(res, 405, { error: "不支持此请求。" });
    if (path === prefix + "/overview") {
      const channels = platforms.list().map((item) => {
        const { model, channelType } = platforms.configuration(item.id);
        return { ...item, model, channelType };
      });
      return json(res, 200, { settings, seoLimits: localSeoLimits, channels, geo: await checks.list(), seo: seoJobs() });
    }
    const check = /^\/api\/admin\/geo\/([a-f0-9-]{36}|[a-f0-9]{64})$/.exec(path);
    if (check) {
      try { return json(res, 200, await checks.diagnostics(check[1])); }
      catch (error) {
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

  return { handle, geoOptions };
}
