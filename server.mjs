import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { articleBodyLimit, createArticleOptimizer } from "./article-optimization.mjs";
import { readArticle } from "./article-reader.mjs";
import { createArticleContext } from "./article-context.mjs";
import { hasArticleEvidence } from "./public/article-evidence.js";
import { articleReportMarkdown, articleReportPath, createArticleReports } from "./article-reports.mjs";
import { createGeoChecks, GeoError } from "./geo-checks.mjs";
import { createGeoPlatforms } from "./geo-platforms.mjs";
import { localAuth } from "./local-auth.mjs";
import { createLocalAdmin, localSeoLimits } from "./local-admin.mjs";
import { publicGeoResult, summarizeSeoReport } from "./evaluation-view.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDir = process.env.YAOSIGHT_LOCAL_DATA_DIR ? resolve(process.env.YAOSIGHT_LOCAL_DATA_DIR) : join(root, "data");
const seoRoot = join(dataDir, "seo");
const host = "127.0.0.1";
const port = Number(process.env.YAOSIGHT_LOCAL_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid YAOSIGHT_LOCAL_PORT");
const origin = "http://" + host + ":" + port;
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const auth = await localAuth(join(dataDir, "account.json"));
const envFile = join(root, ".env");
const localEnv = existsSync(envFile) ? parseEnv(await readFile(envFile, "utf8")) : {};
const geoPlatforms = createGeoPlatforms({ ...localEnv, ...process.env });
const geoChecks = createGeoChecks({
  dataDir: join(dataDir, "checks"),
  legacyDataDir: join(dataDir, "geo"),
  platforms: geoPlatforms,
});
const optimizeArticle = createArticleOptimizer(geoChecks, geoPlatforms);
const articleContext = createArticleContext(join(dataDir, "article-context"));
const articleReports = createArticleReports(join(dataDir, "article-reports"));
const files = { html: "report.html", json: "report.json", log: "crawl.log" };
const staticFiles = new Map([
  ...["/", "/home", "/login"].map((path) => [path, ["public/home.html", "text/html; charset=utf-8"]]),
  ["/dashboard", ["public/index.html", "text/html; charset=utf-8"]],
  ["/home.css", ["public/home.css", "text/css; charset=utf-8"]],
  ["/home.js", ["public/home.js", "text/javascript; charset=utf-8"]],
  ["/theme.js", ["public/theme.js", "text/javascript; charset=utf-8"]],
  ["/overview.js", ["public/overview.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["public/style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/article-agent.js", ["public/article-agent.js", "text/javascript; charset=utf-8"]],
  ["/article-evidence.js", ["public/article-evidence.js", "text/javascript; charset=utf-8"]],
  ["/admin", ["public/admin.html", "text/html; charset=utf-8"]],
  ["/admin.css", ["public/admin.css", "text/css; charset=utf-8"]],
  ["/admin.js", ["public/admin.js", "text/javascript; charset=utf-8"]],
  ...Object.entries({ gpt: "openai", gemini: "gemini-color" })
    .map(([id, name]) => ["/platform-icons/" + id + ".svg", ["vendor/niubigeo/assets/providers/" + name + ".svg", "image/svg+xml"]]),
  ...["doubao", "qwen", "deepseek", "wenxin"]
    .map((id) => ["/platform-icons/" + id + ".png", ["public/platform-icons/" + id + ".png", "image/png"]]),
]);
const jobs = new Map();
function recentSeoJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
}
const admin = await createLocalAdmin({ dataDir, checks: geoChecks, platforms: geoPlatforms, seoJobs: recentSeoJobs, download: downloadRawSeo });
let pending = false;
let crawler;

function validateWebsite(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请输入有效的网址。");
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new Error("请输入以 http:// 或 https:// 开头的完整网址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.port) {
    throw new Error("请输入公开的网站网址，去掉账号、密码、查询参数和自定义端口。");
  }
  const name = url.hostname.replace(/\.$/, "");
  if (isIP(name.replace(/^\[|\]$/g, "")) || !name.includes(".") ||
      /\.(?:localhost|local|internal|test|invalid|onion)$/i.test(name)) {
    throw new Error("请输入公开网站的域名。");
  }
  url.hash = "";
  return url.href;
}

async function input(req, limit = 8192) {
  const type = (req.headers["content-type"] ?? "").split(";")[0];
  if (type !== "application/json") throw new Error("仅接受 JSON 请求。");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("请求太大。");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请输入审计配置。");
  return value;
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function jobDir(job) { return join(seoRoot, job.id); }

async function save(job) {
  await writeFile(join(jobDir(job), "job.json"), JSON.stringify(job, null, 2) + "\n");
}

async function restore() {
  await mkdir(seoRoot, { recursive: true });
  for (const id of await readdir(seoRoot)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    try {
      const job = JSON.parse(await readFile(join(seoRoot, id, "job.json"), "utf8"));
      if (job.id !== id || !Array.isArray(job.files)) continue;
      if (job.status === "running") {
        job.status = "error";
        job.error = "上次运行中断，请重新审计。";
        job.files = existsSync(join(jobDir(job), files.log)) ? ["log"] : [];
        await save(job);
      }
      jobs.set(id, job);
    } catch (error) {
      console.error("无法恢复记录 " + id + "：" + error.message);
    }
  }
}

async function runCrawl(job, binary) {
  const dir = jobDir(job);
  const log = createWriteStream(join(dir, files.log));
  log.on("error", (error) => console.error("无法写入抓取日志：" + error.message));
  try {
    const args = [
      "--url=" + job.url,
      "--workers=" + job.limits.workers,
      "--max-reqs-per-sec=" + job.limits.rate,
      "--max-visited-urls=" + job.limits.pages,
      "--max-queue-length=" + job.limits.queue,
      "--max-depth=" + job.limits.depth,
      "--output-html-report=" + join(dir, files.html),
      "--output-json-file=" + join(dir, files.json),
      "--output-text-file=",
    ];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      crawler = child;
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, job.limits.timeout);
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        crawler = undefined;
        if (expired) reject(new Error("审计超过 3 分钟。请改用较小的入口页面。"));
        else resolve(code);
      });
    });
    if (code !== 0) throw new Error("SiteOne 退出，代码 " + code + "。请查看运行日志。");
    if (!existsSync(join(dir, files.html)) || !existsSync(join(dir, files.json))) {
      throw new Error("SiteOne 未生成完整报告。请查看运行日志。");
    }
    const report = JSON.parse(await readFile(join(dir, files.json), "utf8"));
    if (!report || typeof report !== "object") throw new Error("SiteOne 报告格式无效。");
    job.status = "done";
  } catch (error) {
    job.status = "error";
    job.error = error.message;
  } finally {
    log.end();
    job.files = Object.keys(files).filter((kind) => existsSync(join(dir, files[kind])));
    try { await save(job); }
    catch (error) { console.error("无法保存审计状态：" + error.message); }
  }
}

async function startCrawl(payload, binary) {
  if (pending || [...jobs.values()].some((job) => job.status === "running")) {
    return { status: 409, body: { error: "已有一项审计正在运行。" } };
  }
  if (!binary) return { status: 503, body: { error: "网站检查服务尚未准备好，请联系管理员。" } };
  if (payload.demo !== true && payload.authorized !== true) {
    return { status: 400, body: { error: "请确认你有权审计这个网站。" } };
  }
  const job = {
    id: randomUUID(),
    url: payload.demo === true ? origin + "/demo/" : validateWebsite(payload.url),
    demo: payload.demo === true,
    status: "running",
    createdAt: new Date().toISOString(),
    limits: localSeoLimits,
    files: [],
  };
  pending = true;
  try {
    await mkdir(jobDir(job), { recursive: false });
    await save(job);
    jobs.set(job.id, job);
    void runCrawl(job, binary);
  } finally {
    pending = false;
  }
  return { status: 202, body: { id: job.id } };
}

const demoPages = new Map([
  ["/demo/", '<title>示例产品</title><h1>示例产品</h1><a href="/demo/about">关于</a> <a href="/demo/missing">已失效的链接</a>'],
  ["/demo/about", '<title>关于示例产品</title><meta name="description" content="这是本地 SEO 演示页。"><h1>关于</h1><a href="/demo/">返回首页</a>'],
]);

function downloadRawSeo(res, id, kind) {
  const job = jobs.get(id);
  if (!job?.files.includes(kind)) return json(res, 404, { error: "报告不存在。" });
  const file = join(jobDir(job), files[kind]);
  if (!existsSync(file)) return json(res, 404, { error: "本地报告已移动。" });
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": 'attachment; filename="seo-' + id.slice(0, 8) + '-' + files[kind] + '"',
    "Cache-Control": "no-store",
  });
  const stream = createReadStream(file);
  stream.once("error", () => res.destroy());
  return stream.pipe(res);
}

function publicArticleReport({ id, title, platform, generatedAt, checkId, markdown }) {
  return { id, title, platform, generatedAt, checkId, markdown };
}

function publicSeoJob({ id, url, demo, status, createdAt, files }) {
  return { id, url, demo, status, createdAt, reportReady: status === "done" && files.includes("json") };
}

async function handle(req, res, binary) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers.host !== host + ":" + port) return json(res, 421, { error: "请使用本机工作台地址。" });
  const requestUrl = new URL(req.url, origin);
  const path = requestUrl.pathname;
  if (path.startsWith("/api/admin/")) return admin.handle(req, res, path, input, json, origin);
  if (["/api/session", "/api/setup", "/api/login", "/api/logout"].includes(path)) {
    return auth.handle(req, res, path, input, json, origin);
  }
  if (path === "/dashboard" && !auth.signedIn(req)) {
    res.writeHead(303, { Location: "/login", "Cache-Control": "no-store" });
    return res.end();
  }
  if (path.startsWith("/api/") && !auth.signedIn(req)) {
    return json(res, 401, { error: "请先登录工作台。" });
  }
  if (path === "/api/article-source" || path === "/api/article-optimization") {
    if (req.method !== "POST") return json(res, 405, { error: "不支持此请求。" });
    if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== origin)) {
      return json(res, 403, { error: "来源不符。" });
    }
    const reading = path === "/api/article-source";
    let payload;
    try { payload = await input(req, reading ? 8192 : articleBodyLimit); }
    catch { return json(res, 400, { error: "请求格式无效或正文太长。" }); }
    try {
      if (!reading) {
        const report = await articleReports.save(await optimizeArticle(payload));
        return json(res, 200, publicArticleReport(report));
      }
      const check = payload.checkId ? await geoChecks.result(payload.checkId) : null;
      if (check && (check.kind !== "article" || payload.url !== check.url)) {
        return json(res, 400, { error: "文章链接与关联检测不一致。" });
      }
      return json(res, 200, check ? await articleContext.load(check) : await readArticle(payload.url));
    } catch (error) {
      if (error instanceof GeoError) return json(res, error.status, { error: error.message });
      throw error;
    }
  }
  const articleReport = articleReportPath.exec(path);
  if (path === "/api/article-reports" || articleReport) {
    if (req.method !== "GET") return json(res, 405, { error: "不支持此请求。" });
    if (!articleReport) {
      const reports = await articleReports.list();
      return json(res, 200, reports.map(publicArticleReport));
    }
    try {
      const report = await articleReports.read(articleReport[1]);
      if (!articleReport[2]) return json(res, 200, publicArticleReport(report));
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="article-optimization-' + report.id.slice(0, 8) + '.md"',
      });
      return res.end(articleReportMarkdown(report, { includeModel: false }));
    } catch (error) {
      if (error instanceof GeoError) return json(res, error.status, { error: error.message });
      throw error;
    }
  }
  const geoResult = /^\/api\/geo-checks\/([a-f0-9]{64}|[a-f0-9-]{36})(\/article)?$/.exec(path);
  if (path === "/api/geo-checks" || geoResult) {
    try {
      if (req.method === "GET") {
        if (geoResult) {
          const check = await geoChecks.result(geoResult[1]);
          if (!geoResult[2]) return json(res, 200, publicGeoResult(check));
          if (check.kind !== "article") return json(res, 404, { error: "找不到这篇文章的检测记录。" });
          let source = check;
          let material = await articleContext.find(source);
          const seen = new Set([source.id]);
          while (material.status === "missing" && source.comparisonMode === "retry" &&
              source.baselineId && !seen.has(source.baselineId)) {
            try { source = await geoChecks.result(source.baselineId); }
            catch (error) { if (error.status === 404) break; throw error; }
            seen.add(source.id);
            material = await articleContext.find(source);
          }
          return json(res, 200, { ...material, canUseEvidence: hasArticleEvidence(check) });
        }
        const articleOnly = requestUrl.searchParams.get("kind") === "article";
        const history = articleOnly ? await geoChecks.list(30, { kind: "article", state: "completed" }) : await geoChecks.list();
        return json(res, 200, history.map(({ id, kind, name, createdAt, state, baselineId }) => ({ id, kind, name, createdAt, state, baselineId })));
      }
      if (req.method === "POST" && !geoResult) {
        if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== origin)) {
          return json(res, 403, { error: "来源不符。" });
        }
        let payload;
        try { payload = await input(req); }
        catch { return json(res, 400, { error: "请求格式无效。" }); }
        const check = Object.hasOwn(payload, "baselineId")
          ? await geoChecks.retest(payload.baselineId, payload.useCurrentConfiguration, payload.failedOnly === true)
          : await geoChecks.create({
            kind: payload.kind, name: payload.name, url: payload.url, question: payload.question, platforms: payload.platforms,
            ...admin.geoOptions(payload.platforms),
          });
        articleContext.prepare(check);
        return json(res, 202, { id: check.id });
      }
      return json(res, 405, { error: "不支持此请求。" });
    } catch (error) {
      if (error instanceof GeoError) return json(res, error.status, { error: error.message });
      throw error;
    }
  }
  if (req.method === "POST" && path === "/api/crawls") {
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "来源不符。" });
    let payload;
    try { payload = await input(req); }
    catch { return json(res, 400, { error: "请求格式无效。" }); }
    if (payload.demo !== true && payload.authorized === true) {
      try { validateWebsite(payload.url); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    const result = await startCrawl(payload, binary);
    return json(res, result.status, result.body);
  }
  if (req.method !== "GET") return json(res, 405, { error: "不支持此请求。" });
  if (path === "/api/status") {
    const platforms = geoPlatforms.list().map(({ id, label, ready, vision }) => ({ id, label, ready, vision }));
    return json(res, 200, { jobs: recentSeoJobs().map(publicSeoJob), platforms });
  }
  if (path === "/api/overview") {
    const cutoff = Date.now() - 32 * 24 * 60 * 60 * 1000;
    const geo = await geoChecks.list(Infinity);
    const records = [...geo.map((item) => ({ ...item, type: "geo", status: item.state })),
      ...[...jobs.values()].map((item) => ({
        ...item, type: "seo", name: item.demo ? "SEO 本地样例" : item.url,
        status: item.status === "done" ? "completed" : item.status === "error" ? "failed" : item.status,
      }))];
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(res, 200, {
      days: records.filter((item) => Date.parse(item.createdAt) >= cutoff)
        .reduce((days, item) => {
          const date = dayKey.format(new Date(item.createdAt));
          days[date] ||= { geo: 0, seo: 0, completed: 0, running: 0 };
          days[date][item.type]++;
          if (item.status === "completed" || item.status === "running") days[date][item.status]++;
          return days;
        }, Object.create(null)),
      recent: records.slice(0, 5).map(({ name, type, status, createdAt }) => ({ name, type, status, createdAt })),
    });
  }
  const seoResult = /^\/api\/seo-reports\/([0-9a-f-]{36})$/.exec(path);
  if (seoResult) {
    const job = jobs.get(seoResult[1]);
    if (!job || !publicSeoJob(job).reportReady) return json(res, 404, { error: "暂时没有可查看的报告。" });
    try {
      const report = JSON.parse(await readFile(join(jobDir(job), files.json), "utf8"));
      return json(res, 200, { ...publicSeoJob(job), ...summarizeSeoReport(report) });
    } catch (error) {
      if (error.code === "ENOENT") return json(res, 404, { error: "报告文件已移动。" });
      throw error;
    }
  }
  const item = staticFiles.get(path);
  if (item) {
    const content = await readFile(join(root, item[0]));
    res.writeHead(200, { "Content-Type": item[1], "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'" + (path === "/dashboard" ? " blob:" : "") + "; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    return res.end(content);
  }
  if (demoPages.has(path)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8">' + demoPages.get(path) + '</html>');
  }
  if (path === "/demo/missing") {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    return res.end("<title>页面不存在</title><h1>404</h1>");
  }
  return json(res, 404, { error: "页面不存在。" });
}

await restore();
const vendor = join(root, "vendor", "siteone");
let binary;
if (existsSync(vendor)) {
  const find = (await readdir(vendor, { recursive: true })).find((name) => /(?:^|[/\\])(?:siteone-crawler|crawler)\.exe$/i.test(name));
  if (find) binary = join(vendor, find);
}

const server = createServer((req, res) => {
  void handle(req, res, binary).catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: "工作台暂时不可用，请稍后重试。" });
    else res.destroy();
  });
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log("曜见 · 搜索与 AI 可见性工作台 " + origin + "/");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  crawler?.kill();
  server.close();
});
