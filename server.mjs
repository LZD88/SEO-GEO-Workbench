import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createGeoChecks, GeoError } from "./geo-checks.mjs";
import { createGeoPlatforms } from "./geo-platforms.mjs";
import { localAuth } from "./local-auth.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const seoRoot = join(root, "data", "seo");
const host = "127.0.0.1";
const origin = "http://" + host + ":8790";
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const auth = await localAuth(join(root, "data", "account.json"));
const envFile = join(root, ".env");
const localEnv = existsSync(envFile) ? parseEnv(await readFile(envFile, "utf8")) : {};
const geoPlatforms = createGeoPlatforms({ ...localEnv, ...process.env });
const geoChecks = createGeoChecks({
  dataDir: join(root, "data", "checks"),
  legacyDataDir: join(root, "data", "geo"),
  platforms: geoPlatforms,
});
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
  ...Object.entries({ gpt: "openai", gemini: "gemini-color" })
    .map(([id, name]) => ["/platform-icons/" + id + ".svg", ["vendor/niubigeo/assets/providers/" + name + ".svg", "image/svg+xml"]]),
  ...["doubao", "qwen", "deepseek", "wenxin"]
    .map((id) => ["/platform-icons/" + id + ".png", ["public/platform-icons/" + id + ".png", "image/png"]]),
]);
const jobs = new Map();
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

async function input(req) {
  const type = (req.headers["content-type"] ?? "").split(";")[0];
  if (type !== "application/json") throw new Error("仅接受 JSON 请求。");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) throw new Error("请求太大。");
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
      "--workers=2",
      "--max-reqs-per-sec=2",
      "--max-visited-urls=100",
      "--max-queue-length=150",
      "--max-depth=3",
      "--output-html-report=" + join(dir, files.html),
      "--output-json-file=" + join(dir, files.json),
      "--output-text-file=",
    ];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      crawler = child;
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, 180_000);
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
  if (!binary) return { status: 503, body: { error: "SiteOne 尚未安装，请运行 setup.ps1。" } };
  if (payload.demo !== true && payload.authorized !== true) {
    return { status: 400, body: { error: "请确认你有权审计这个网站。" } };
  }
  const job = {
    id: randomUUID(),
    url: payload.demo === true ? origin + "/demo/" : validateWebsite(payload.url),
    demo: payload.demo === true,
    status: "running",
    createdAt: new Date().toISOString(),
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

async function handle(req, res, binary) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers.host !== host + ":8790") return json(res, 421, { error: "请使用本机工作台地址。" });
  const path = new URL(req.url, origin).pathname;
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
  const geoResult = /^\/api\/geo-checks\/([a-f0-9]{64}|[a-f0-9-]{36})$/.exec(path);
  if (path === "/api/geo-checks" || geoResult) {
    try {
      if (req.method === "GET") {
        return json(res, 200, geoResult ? await geoChecks.result(geoResult[1]) : await geoChecks.list());
      }
      if (req.method === "POST" && !geoResult) {
        if (req.headers.origin && req.headers.origin !== origin) {
          return json(res, 403, { error: "来源不符。" });
        }
        let payload;
        try { payload = await input(req); }
        catch { return json(res, 400, { error: "请求格式无效。" }); }
        return json(res, 202, await geoChecks.create(payload));
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
    const recent = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
    return json(res, 200, { jobs: recent, platforms: geoPlatforms.list() });
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
  const match = /^\/api\/reports\/([0-9a-f-]{36})\/(html|json|log)$/.exec(path);
  if (match) {
    const [, id, kind] = match;
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
  const item = staticFiles.get(path);
  if (item) {
    const content = await readFile(join(root, item[0]));
    res.writeHead(200, { "Content-Type": item[1], "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
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
    if (!res.headersSent) json(res, 500, { error: "工作台出错，请查看启动日志。" });
    else res.destroy();
  });
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(8790, host, () => {
  console.log("曜见 · 搜索与 AI 可见性工作台 " + origin + "/");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  crawler?.kill();
  server.close();
});
