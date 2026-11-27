import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createLocalAccount } from "../local-auth.mjs";
import { createArticleReports } from "../article-reports.mjs";

test("local users get a readable report while separately authenticated admins can inspect runs", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yaosight-user-admin-"));
  const password = () => randomBytes(16).toString("hex");
  const memberPassword = password();
  const operatorPassword = password();
  await createLocalAccount(join(dataDir, "account.json"), memberPassword);
  const seoId = "12345678-1234-1234-1234-123456789012";
  const geoId = "12345678-1234-1234-1234-123456789013";
  const seoDir = join(dataDir, "seo", seoId);
  const checksDir = join(dataDir, "checks");
  await Promise.all([mkdir(seoDir, { recursive: true }), mkdir(checksDir, { recursive: true })]);
  const createdAt = new Date().toISOString();
  const job = { id: seoId, status: "done", url: "https://example.com/", files: ["json", "log"], createdAt };
  const report = { stats: { totalUrls: 2 }, tables: { "404": { rows: [{ url: "https://example.com/missing" }] } } };
  const check = { id: geoId, name: "Example", kind: "brand", url: "https://example.com/", question: "Which brand?",
    state: "completed", createdAt, sampleCount: 3, promptVersion: 1,
    configuration: [{ id: "gpt", model: "private-model-id", routeFingerprint: "route", search: true }],
    samples: [{ platformId: "gpt", model: "GPT", modelVersion: "internal-version", answer: "Example", mentioned: true, number: 1 }],
  };
  await Promise.all([
    writeFile(join(seoDir, "job.json"), JSON.stringify(job)),
    writeFile(join(seoDir, "report.json"), JSON.stringify(report)),
    writeFile(join(seoDir, "crawl.log"), "crawler input and configuration"),
    writeFile(join(checksDir, geoId + ".json"), JSON.stringify(check)),
  ]);
  const article = await createArticleReports(join(dataDir, "article-reports")).save({
    title: "Article report", platform: "GPT", model: "internal-model", generatedAt: createdAt, checkId: geoId, markdown: "An example report.",
  });
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const origin = "http://127.0.0.1:" + port;
  const command = fileURLToPath(new URL("../server.mjs", import.meta.url));
  let child;
  let closed;
  function start() {
    child = spawn(process.execPath, [command], {
      env: { ...process.env, YAOSIGHT_LOCAL_PORT: String(port), YAOSIGHT_LOCAL_DATA_DIR: dataDir },
      stdio: "ignore", windowsHide: true,
    });
    closed = once(child, "exit");
  }
  async function stop() {
    if (child.exitCode === null) child.kill();
    await closed;
  }
  start();
  t.after(stop);

  const request = (path, { body, cookie, source = origin } = {}) => fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json", Origin: source }),
      ...(cookie && { Cookie: cookie }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  async function waitForServer() {
    for (let tryCount = 0; tryCount < 40; tryCount++) {
      try { return await request("/api/session"); }
      catch { if (child.exitCode !== null) throw new Error("Local test server exited"); await delay(100); }
    }
    throw new Error("Local test server did not start");
  }
  await waitForServer();
  const cookieFor = async (route, pass) => {
    const response = await request(route, { body: { password: pass } });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie()[0].split(";")[0];
  };
  const user = await cookieFor("/api/login", memberPassword);
  assert.equal((await request("/api/admin/overview", { cookie: user })).status, 401);
  assert.equal((await request("/api/admin/setup", { cookie: user, body: { password: memberPassword } })).status, 401);
  assert.equal((await (await request("/api/admin/session")).json()).configured, false);

  // The operator may initialize an account on disk while the local process is running.
  await createLocalAccount(join(dataDir, "admin-account.json"), operatorPassword);
  assert.equal((await request("/api/admin/login", { body: { password: memberPassword } })).status, 401);
  const admin = await cookieFor("/api/admin/login", operatorPassword);
  assert.notEqual(admin.split("=")[0], user.split("=")[0]);

  const details = await (await request("/api/geo-checks/" + geoId, { cookie: user })).json();
  assert.equal(details.samples[0].answer, "Example");
  assert.equal(details.samples[0].modelVersion, undefined);
  assert.equal(details.sampleCount, undefined);
  assert.equal(details.configuration, undefined);
  const run = await (await request("/api/admin/geo/" + geoId, { cookie: admin })).json();
  assert.equal(run.configuration[0].model, "private-model-id");
  assert.equal(run.sampleCount, 3);
  assert.equal(run.samples[0].modelVersion, "internal-version");
  const articlePath = "/api/admin/articles/" + article.id;
  assert.equal((await request(articlePath, { cookie: user })).status, 401);
  assert.equal((await (await request("/api/admin/overview", { cookie: admin })).json()).articles[0].model, "internal-model");
  assert.equal((await (await request(articlePath, { cookie: admin })).json()).checkId, geoId);
  assert.match(await (await request(articlePath + "/markdown", { cookie: admin })).text(), /An example report/);
  const policy = { sampleCount: 5, webSearch: false };
  assert.equal((await request("/api/admin/settings", { cookie: user, body: policy })).status, 401);
  assert.equal((await request("/api/admin/settings", { cookie: admin, body: policy, source: "https://elsewhere.example" })).status, 403);
  assert.equal((await request("/api/admin/settings", { cookie: admin, body: { ...policy, sampleCount: 8 } })).status, 400);
  assert.equal((await request("/api/admin/settings", { cookie: admin, body: policy })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "evaluation-settings.json"), "utf8")), policy);

  const summary = await (await request("/api/seo-reports/" + seoId, { cookie: user })).json();
  assert.equal(summary.pages, 2);
  assert.equal(summary.findings[0].title, "检查坏链");
  assert.equal(summary.files, undefined);
  assert.equal((await request("/api/reports/" + seoId + "/log", { cookie: user })).status, 404);
  assert.equal((await request("/api/admin/reports/" + seoId + "/log", { cookie: user })).status, 401);
  const raw = await request("/api/admin/reports/" + seoId + "/log", { cookie: admin });
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), "crawler input and configuration");

  const limits = { workers: 1, rate: 1, pages: 20, queue: 40, depth: 2, timeout: 60000 };
  assert.equal((await request("/api/admin/seo-settings", { cookie: user, body: limits })).status, 401);
  assert.equal((await request("/api/admin/seo-settings", { cookie: admin, body: { ...limits, pages: 101 } })).status, 400);
  assert.equal((await request("/api/admin/seo-settings", { cookie: admin, body: limits })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "evaluation-settings.json"), "utf8")), { ...policy, seoLimits: limits });

  const enabled = { enabled: true, message: "升级中 <script>alert(1)</script>" };
  const route = "/api/admin/maintenance";
  assert.equal((await request(route, { cookie: user, body: enabled })).status, 401);
  assert.equal((await request(route, { cookie: admin, body: enabled, source: "https://elsewhere.example" })).status, 403);
  assert.equal((await request(route, { cookie: admin, body: { enabled: true, message: "a".repeat(241) } })).status, 400);
  assert.equal((await request(route, { cookie: admin, body: enabled })).status, 200);
  for (const page of ["/", "/home", "/login", "/dashboard"]) {
    const result = await request(page, { cookie: user });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("retry-after"), "60");
    const content = await result.text();
    assert.ok(content.includes("服务维护中"));
    assert.ok(content.includes("&lt;script&gt;"));
    assert.ok(!content.includes("<script>"));
  }
  for (const api of ["/api/geo-checks", "/api/crawls", "/api/article-source", "/api/article-optimization", "/api/login"]) {
    const response = await request(api, { cookie: user, body: {} });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "maintenance", error: enabled.message });
  }
  assert.equal((await request("/api/status", { cookie: user })).status, 503);
  assert.equal((await request("/admin")).status, 200);
  assert.equal((await request("/admin-console.css")).status, 200);
  assert.equal((await request("/api/admin/overview", { cookie: admin })).status, 200);
  assert.equal((await request("/demo/")).status, 200);

  await stop();
  start();
  const session = await waitForServer();
  assert.equal(session.status, 503);
  const nextAdmin = await cookieFor("/api/admin/login", operatorPassword);
  const settings = await (await request("/api/admin/overview", { cookie: nextAdmin })).json();
  assert.deepEqual(settings.seoLimits, limits);
  assert.equal(settings.maintenance.enabled, true);
  assert.equal((await request(route, { cookie: nextAdmin, body: { ...enabled, enabled: false } })).status, 200);
  const resumed = await cookieFor("/api/login", memberPassword);
  assert.equal((await request("/dashboard", { cookie: resumed })).status, 200);
  assert.equal((await request("/api/status", { cookie: resumed })).status, 200);
});
