import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readArticle } from "../article-reader.mjs";
import { GeoError } from "../geo-checks.mjs";
import { HttpError, readJson, sendJson } from "./http.mjs";
import { runSiteOne } from "./siteone.mjs";

export function createFetchServer({ token, article = readArticle, crawl = runSiteOne }) {
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{43,}$/.test(token)) {
    throw new Error("FETCH_SERVICE_TOKEN must be a random URL-safe token");
  }
  const authorization = Buffer.from("Bearer " + token);
  const active = { "/article": 0, "/crawl": 0 };
  const runners = { "/article": article, "/crawl": crawl };
  const limits = { "/article": 2, "/crawl": 1 };
  const server = createServer({ requestTimeout: 25000 }, async (req, res) => {
    const received = Buffer.from(req.headers.authorization ?? "");
    if (received.length !== authorization.length || !timingSafeEqual(received, authorization)) {
      return sendJson(res, 401, { error: "未授权。" });
    }
    if (req.method !== "POST" || !Object.hasOwn(runners, req.url)) return sendJson(res, 404, { error: "资源不存在。" });
    if (active[req.url] >= limits[req.url]) return sendJson(res, 429, { error: "读取服务繁忙。" });
    active[req.url]++;
    try {
      const input = await readJson(req, 4096);
      return sendJson(res, 200, await runners[req.url](req.url === "/article" ? input.url : input));
    } catch (error) {
      if (error instanceof HttpError || error instanceof GeoError) {
        return sendJson(res, error.status, { error: error.message });
      }
      return sendJson(res, 502, { error: "抓取暂时无法完成。" });
    } finally {
      active[req.url]--;
    }
  });
  return server;
}
