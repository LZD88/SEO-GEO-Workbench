import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import * as oidc from "openid-client";
import { once } from "node:events";
import test from "node:test";
import { createPool, databaseVersion } from "../production/db.mjs";
import { migrate } from "../production/migrate.mjs";
import { inTransaction } from "../production/db.mjs";
import { cancelJob, claim, enqueue, finishStep, getJob, takeStep, usage } from "../production/jobs.mjs";
import { createProductionServer } from "../production/server.mjs";
import { executeGeo } from "../production/geo.mjs";
import { runJob } from "../production/worker-loop.mjs";
import { createFetchServer } from "../production/fetch-server.mjs";
import { createArticleHandlers } from "../production/article-jobs.mjs";
import { createSeoHandler } from "../production/seo-jobs.mjs";
import { prepareGeoMonitor, dueMonitor } from "../production/monitoring.mjs";
import { setChannelPaused, operationalStatus } from "../production/operations.mjs";
import { importRecords } from "../production/import-history.mjs";
import { prepareSeo, verifySite } from "../production/sites.mjs";
import { bootstrapWorkspace, createSession, inviteMember, tokenHash } from "../production/workspaces.mjs";

const origin = new URL("https://yaosight.integration.test");
const adminUrl = process.env.YS_TEST_DATABASE_ADMIN_URL;

async function testDatabase(t) {
  const suffix = randomBytes(6).toString("hex");
  const database = "ys_test_" + suffix;
  const appRole = "ys_app_" + suffix;
  const admin = createPool(adminUrl);
  const scoped = new URL(adminUrl);
  scoped.pathname = "/" + database;
  const owner = createPool(scoped.href);
  const password = randomBytes(18).toString("hex");
  const app = new URL(scoped);
  app.username = appRole;
  app.password = password;
  const pool = createPool(app.href);
  t.after(async () => {
    await Promise.all([owner.end(), pool.end()]);
    try {
      await admin.query('DROP DATABASE IF EXISTS "' + database + '"');
      await admin.query('DROP ROLE IF EXISTS "' + appRole + '"');
    } finally { await admin.end(); }
  });
  await admin.query('CREATE ROLE "' + appRole + '" LOGIN PASSWORD ' + "'" + password + "'");
  await admin.query('CREATE DATABASE "' + database + '"');
  const version = await migrate(owner, appRole);
  assert.equal(await migrate(owner, appRole), version);
  assert.equal(await databaseVersion(pool), version);
  await assert.rejects(pool.query("CREATE TABLE yaosight.unpermitted (id integer)"), { code: "42501" });
  await assert.rejects(pool.query("DELETE FROM yaosight.schema_migrations"), { code: "42501" });
  return pool;
}

async function client(t, pool, config, services = {}) {
  const server = createProductionServer({
    pool, origin, readiness: async () => true, ...services,
    settings: async () => { if (config) return config; assert.fail("Invalid login flow reached the issuer"); },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  return (path, { token, method = "GET", body, requestOrigin = origin.origin, cookie, key } = {}) => fetch(base + path, {
    method, redirect: "manual",
    headers: {
      ...(token && { Cookie: "__Host-yaosight_session=" + token }),
      ...(cookie && { Cookie: cookie }),
      Origin: requestOrigin,
      ...(key && { "Idempotency-Key": key }),
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
}

test("production health endpoint does not require a session", async (t) => {
  const send = await client(t, null);
  const response = await send("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.match((await send("/")).headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("migration, one-time invitations, membership, sessions and API origin checks", { skip: !adminUrl }, async (t) => {
  const pool = await testDatabase(t);
  const send = await client(t, pool);
  const owner = { issuer: "https://oidc.integration.test", subject: "owner", email: "owner@example.com" };
  const member = { issuer: owner.issuer, subject: "viewer", email: "viewer@example.com" };
  const first = await bootstrapWorkspace(pool, "Studio A", owner.email);
  const second = await bootstrapWorkspace(pool, "Studio B", "other@example.com");
  const ownerToken = await createSession(pool, owner, tokenHash(first.token));
  await assert.rejects(createSession(pool, owner, tokenHash(first.token)), { status: 403 });
  const { rows: [account] } = await pool.query("SELECT id FROM yaosight.accounts WHERE subject='owner'");
  const deniedInvite = await inviteMember(pool, account.id, first.id, member.email, "viewer");
  await pool.query("UPDATE yaosight.invitations SET expires_at=now() WHERE token_hash=$1", [tokenHash(deniedInvite)]);
  await assert.rejects(createSession(pool, member, tokenHash(deniedInvite)), { status: 403 });
  const invite = await inviteMember(pool, account.id, first.id, member.email, "viewer");
  await assert.rejects(createSession(pool, { ...member, email: "wrong@example.com" }, tokenHash(invite)), { status: 403 });
  const viewingToken = await createSession(pool, member, tokenHash(invite));
  const path = "/api/workspaces/" + first.id;
  const options = { method: "POST", body: { name: "Website" }, token: ownerToken };
  assert.equal((await send(path + "/projects", { ...options, requestOrigin: "https://another.test" })).status, 403);
  assert.equal((await send(path + "/projects", { ...options, token: viewingToken })).status, 403);
  assert.equal((await send("/api/workspaces/" + second.id + "/projects", { token: ownerToken })).status, 404);
  const response = await send(path + "/projects", options);
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.equal((await send(path + "/projects/" + id, { token: viewingToken })).status, 200);
  const restarted = await client(t, pool);
  assert.equal((await restarted("/api/me", { token: viewingToken })).status, 200);
  const members = await (await send(path + "/members", { token: ownerToken })).json();
  const actor = members.find(({ email }) => email === member.email);
  assert.equal((await send(path + "/members/" + actor.id, { method: "DELETE", token: ownerToken })).status, 200);
  assert.equal((await restarted(path + "/projects/" + id, { token: viewingToken })).status, 404);
  const events = await (await send(path + "/audit-events", { token: ownerToken })).json();
  assert.ok(events.some((event) => event.action === "member.removed" && event.actor_id === account.id && event.target === actor.id));
  assert.equal((await send("/auth/logout", { method: "POST", token: ownerToken })).status, 303);
  assert.equal((await restarted("/api/me", { token: ownerToken })).status, 401);
  const state = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO yaosight.login_flows (state_hash, verifier, nonce, expires_at) VALUES ($1,'verifier','nonce',now())", [tokenHash(state)],
  );
  assert.equal((await send("/auth/callback?state=" + state, { cookie: "__Host-yaosight_flow=" + state })).status, 403);
});
test("OIDC callback validates the state, the signed token and the invited email", { skip: !adminUrl }, async (t) => {
  const pool = await testDatabase(t);
  const invited = await bootstrapWorkspace(pool, "OIDC test", "oidc@example.com");
  const clientId = "pilot-test";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let authorization;
  const issuer = createServer(async (req, res) => {
    try {
      if (req.url === "/jwks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "issuer-key", alg: "RS256" }] }));
      }
      assert.equal(req.url, "/token");
      const credentials = Buffer.from(req.headers.authorization.split(" ")[1], "base64")
        .toString().split(":").map(decodeURIComponent);
      assert.deepEqual(credentials, [clientId, "test-secret"]);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(form.get("code"), "one-use-code");
      assert.equal(form.get("redirect_uri"), new URL("/auth/callback", origin).href);
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), authorization.searchParams.get("code_challenge"));
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const payload = encode({ alg: "RS256", kid: "issuer-key" }) + "." + encode({
        iss: issuerUrl, aud: clientId, sub: "oidc-user", nonce: authorization.searchParams.get("nonce"),
        email: "oidc@example.com", email_verified: true, exp: now + 300, iat: now,
      });
      const idToken = payload + "." + sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token_type: "Bearer", access_token: "test-access", id_token: idToken }));
    } catch (error) {
      res.writeHead(500);
      res.end();
      t.diagnostic(error.message);
    }
  });
  issuer.listen(0, "127.0.0.1");
  await once(issuer, "listening");
  t.after(() => new Promise((resolve) => issuer.close(resolve)));
  const issuerUrl = "http://127.0.0.1:" + issuer.address().port;
  const config = new oidc.Configuration({
    issuer: issuerUrl, authorization_endpoint: issuerUrl + "/auth", token_endpoint: issuerUrl + "/token", jwks_uri: issuerUrl + "/jwks",
  }, clientId, { client_secret: "test-secret" }, oidc.ClientSecretBasic("test-secret"));
  oidc.allowInsecureRequests(config);
  oidc.enableNonRepudiationChecks(config);
  const send = await client(t, pool, config);
  const login = await send("/auth/login?invite=" + invited.token);
  assert.equal(login.status, 303);
  authorization = new URL(login.headers.get("location"));
  const flow = login.headers.getSetCookie()[0].split(";")[0];
  const callback = "/auth/callback?code=one-use-code&state=" + authorization.searchParams.get("state");
  assert.equal((await send(callback)).status, 403);
  const done = await send(callback, { cookie: flow });
  assert.equal(done.status, 303);
  const session = done.headers.getSetCookie().find((value) => value.startsWith("__Host-yaosight_session="));
  assert.match(session, /HttpOnly; Secure; SameSite=Lax/);
  const data = await (await send("/api/me", { cookie: session.split(";")[0] })).json();
  assert.equal(data.email, "oidc@example.com");
  assert.equal((await send(callback, { cookie: flow })).status, 403);
});

test("durable leases, idempotency, parallel budget reservations and cancellation", { skip: !adminUrl }, async (t) => {
  const pool = await testDatabase(t);
  const space = await bootstrapWorkspace(pool, "Queue test", "worker@example.com");
  const { rows: [project] } = await pool.query("INSERT INTO yaosight.projects(workspace_id,name) VALUES ($1,'Queue') RETURNING id", [space.id]);
  const scope = { workspaceId: space.id, projectId: project.id };
  await pool.query("INSERT INTO yaosight.workspace_limits(workspace_id, model_limit) VALUES ($1,3)", [space.id]);
  const step = { input: {}, category: "model_limit", estimate: 1, channel: "gpt" };
  const input = { ...scope, kind: "geo", requestKey: "first", input: { question: "test" }, steps: [step, step, step] };
  const submit = (value) => inTransaction(pool, (db) => enqueue(db, value));
  const results = await Promise.allSettled([submit(input), submit({ ...input, requestKey: "competing" })]);
  const accepted = results.find(({ status }) => status === "fulfilled").value;
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.find(({ status }) => status === "rejected").reason.status, 429);
  const { rows: [stored] } = await pool.query("SELECT request_key FROM yaosight.jobs WHERE id=$1", [accepted.id]);
  const repeat = { ...input, requestKey: stored.request_key };
  assert.deepEqual(await submit(repeat), accepted);
  await assert.rejects(submit({ ...repeat, input: {} }), { status: 409 });
  const leases = await Promise.all([claim(pool), claim(pool)]);
  const job = leases.find(Boolean);
  assert.equal(leases.filter(Boolean).length, 1);
  const step1 = await takeStep(pool, job);
  assert.equal(step1.step_index, 0);
  await finishStep(pool, job, step1, { state: "succeeded", units: 1, result: { answer: "Existing" } });
  const interrupted = await takeStep(pool, job);
  assert.equal(interrupted.step_index, 1);
  await pool.query("UPDATE yaosight.jobs SET leased_until=now() WHERE id=$1", [job.id]);
  assert.equal(await finishStep(pool, job, interrupted, { state: "succeeded", units: 1 }), false);
  const replacement = await claim(pool);
  assert.notEqual(replacement.lease_token, job.lease_token);
  const last = await takeStep(pool, replacement);
  assert.equal(last.step_index, 2);
  await finishStep(pool, replacement, last, { state: "succeeded", units: 1 });
  assert.equal(await takeStep(pool, replacement), null);
  const restored = await getJob(pool, { ...scope, jobId: job.id });
  assert.equal(restored.status, "review");
  assert.deepEqual(restored.steps.map(({ state }) => state), ["succeeded", "review", "succeeded"]);
  assert.equal(restored.steps[0].result.answer, "Existing");
  assert.deepEqual(await usage(pool, space.id), [{ category: "model_limit", reserved: 0, actual: 2, awaiting_review: 1 }]);
  await pool.query("UPDATE yaosight.workspace_limits SET model_limit=4 WHERE workspace_id=$1", [space.id]);
  const other = await submit({ ...input, requestKey: "canceled", steps: [step] });
  assert.deepEqual(await inTransaction(pool, (db) => cancelJob(db, { ...scope, jobId: other.id })), { status: "canceled" });
  assert.equal(await claim(pool), null);
  assert.equal((await usage(pool, space.id))[0].reserved, 0);
});
test("project GEO runs and report downloads keep data and usage inside the authorized project", { skip: !adminUrl }, async (t) => {
  const pool = await testDatabase(t);
  const issuer = "https://id.integration.test";
  const w1 = await bootstrapWorkspace(pool, "Team 1", "one@example.com");
  const w2 = await bootstrapWorkspace(pool, "Team 2", "two@example.com");
  const u1 = await createSession(pool, { issuer, subject: "one", email: "one@example.com" }, tokenHash(w1.token));
  const u2 = await createSession(pool, { issuer, subject: "two", email: "two@example.com" }, tokenHash(w2.token));
  const { rows: [owner] } = await pool.query("SELECT id FROM yaosight.accounts WHERE subject='one'");
  await pool.query("INSERT INTO yaosight.workspace_limits(workspace_id, model_limit) VALUES ($1,3)", [w1.id]);
  const invitation = await inviteMember(pool, owner.id, w1.id, "viewer@example.com", "viewer");
  const viewer = await createSession(pool, { issuer, subject: "viewer", email: "viewer@example.com" }, tokenHash(invitation));
  const called = [];
  const platforms = {
    list: () => [{ id: "gpt", label: "GPT", search: true, ready: true }],
    configuration: () => ({ id: "gpt", model: "model-v1", routeFingerprint: "configured", channelType: "relay-api", search: true }),
    async answer(id) {
      called.push(id);
      return { text: "One Brand", citations: [{ url: "https://one.example/article?utm_campaign=example", source: "provider" }] };
    },
  };
  const send = await client(t, pool, undefined, {
    platforms, evaluationAdmins: new Set([owner.id]), artifacts: {
      async read(key) {
        assert.equal(key, "test-object");
        return { Body: Readable.from(["<title>SEO demo</title>"]) };
      },
    },
  });
  const create = async (space, token) => {
    const res = await send("/api/workspaces/" + space.id + "/projects", { token, method: "POST", body: { name: "Example project" } });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };
  const first = await create(w1, u1), second = await create(w2, u2);
  const p1 = "/api/workspaces/" + w1.id + "/projects/" + first;
  const p2 = "/api/workspaces/" + w2.id + "/projects/" + second;
  const payload = { kind: "geo", target: {
    kind: "article", name: "Example", url: "https://one.example/article", question: "Which sources?",
    platforms: ["gpt"], sampleCount: 1, webSearch: true,
  } };
  const submit = { token: u1, method: "POST", key: "first-attempt", body: payload };
  assert.equal((await send(p1 + "/jobs", { ...submit, token: viewer })).status, 403);
  const response = await send(p1 + "/jobs", submit);
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.equal((await send(p1 + "/jobs/" + id, { token: u2 })).status, 404);
  const foreign = await send(p2 + "/jobs", { ...submit, token: u2, key: "illegal-retest", body: { kind: "geo", baselineId: id } });
  assert.equal(foreign.status, 404);
  assert.equal(called.length, 0);
  const logs = [];
  await runJob(pool, { geo: (step) => executeGeo(step, platforms) }, { log: (event) => logs.push(event) });
  const job = await (await send(p1 + "/jobs/" + id, { token: viewer })).json();
  assert.equal(job.status, "succeeded");
  assert.equal(job.steps[0].result.searchStatus, undefined);
  assert.equal(job.steps[0].result.channelType, undefined);
  assert.equal(job.input.configuration, undefined);
  assert.equal((await send("/admin", { token: viewer })).status, 404);
  assert.equal((await send("/admin", { token: u1 })).status, 200);
  assert.equal((await send(p1 + "/evaluation/" + id, { token: viewer })).status, 404);
  assert.equal((await send(p2 + "/evaluation", { token: u1 })).status, 404);
  const internal = await (await send(p1 + "/evaluation/" + id, { token: u1 })).json();
  assert.equal(internal.steps[0].result.searchStatus, "unconfirmed");
  assert.equal(internal.steps[0].result.channelType, "relay-api");
  assert.equal(internal.input.configuration[0].model, "model-v1");
  const policy = { sampleCount: 3, webSearch: false, minimumCoverage: 0.8, path: "/", pages: 40, depth: 3, rate: 2 };
  assert.equal((await send(p1 + "/evaluation", { token: viewer, method: "POST", body: policy })).status, 404);
  assert.equal((await send(p1 + "/evaluation", { token: u1, method: "POST", body: policy })).status, 200);
  assert.equal((await (await send(p1 + "/evaluation", { token: u1 })).json()).settings.sampleCount, 3);
  await pool.query("UPDATE yaosight.workspace_limits SET model_limit=4 WHERE workspace_id=$1", [w1.id]);
  const next = await send(p1 + "/jobs", { ...submit, key: "settings-take-effect" });
  assert.equal(next.status, 202);
  const nextId = (await next.json()).id;
  const nextJob = await (await send(p1 + "/evaluation/" + nextId, { token: u1 })).json();
  assert.equal(nextJob.steps.length, 3);
  assert.equal(nextJob.input.configuration[0].search, false);
  assert.equal(job.steps[0].result.cited, true);
  assert.equal(called.length, 1);
  assert.ok(!JSON.stringify(logs).includes("One Brand"));
  const { rows: [report] } = await pool.query(`
    INSERT INTO yaosight.artifacts(workspace_id,project_id,object_key,name,media_type,byte_length)
    VALUES ($1,$2,'test-object','seo.html','text/html',23) RETURNING id
  `, [w1.id, first]);
  assert.equal((await send(p2 + "/reports/" + report.id, { token: u2 })).status, 404);
  assert.equal((await send(p1 + "/reports/" + report.id, { token: viewer })).status, 404);
  const download = await send(p1 + "/reports/" + report.id, { token: u1 });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="seo.html"');
  assert.equal(await download.text(), "<title>SEO demo</title>");
});
test("periodic GEO freezes questions, deduplicates periods and preserves other channels when paused", { skip: !adminUrl }, async (t) => {
  const pool = await testDatabase(t);
  const space = await bootstrapWorkspace(pool, "Monitor", "owner@example.com");
  const token = await createSession(pool, { issuer: origin.href, subject: "owner", email: "owner@example.com" }, tokenHash(space.token));
  const { rows: [project] } = await pool.query("INSERT INTO yaosight.projects(workspace_id,name) VALUES ($1,'Monitor') RETURNING id", [space.id]);
  const scope = { workspaceId: space.id, projectId: project.id };
  const root = "/api/workspaces/" + space.id + "/projects/" + project.id;
  const calls = [];
  const platforms = {
    list: () => ["gpt", "gemini"].map((id) => ({ id, label: id, ready: true, search: true })),
    configuration: (id) => ({ id, model: id + "-test", routeFingerprint: id, channelType: "direct-api", search: true }),
    async answer(id) { calls.push(id); return { text: "Alpha", citations: [], rawProviderResponse: { model: id + "-1" } }; },
  };
  const send = await client(t, pool, undefined, { platforms });
  const plan = { kind: "geo", name: "Daily", cadence: "daily", active: true, configuration: {
    kind: "brand", name: "Alpha", url: "https://example.com/", questions: ["What is Alpha?", "Where is Alpha?"], platforms: ["gpt", "gemini"],
  } };
  const created = await send(root + "/monitors", { token, method: "POST", body: plan });
  assert.equal(created.status, 200, await created.clone().text());
  const { id } = await created.json();
  const tick = () => dueMonitor(pool, (_db, _scope, _kind, configuration) => prepareGeoMonitor(configuration, platforms));
  assert.deepEqual((await Promise.all([tick(), tick()])).sort(), [false, true]);
  const details = await (await send(root + "/monitors/" + id, { token })).json();
  assert.equal(details.periods.length, 1);
  assert.equal(details.current_version, undefined);
  assert.equal(details.configuration.sampleCount, undefined);
  const jobId = details.periods[0].job_id;
  const updated = await send(root + "/monitors/" + id, { token, method: "PATCH", body: {
    ...plan, active: false, configuration: { ...plan.configuration, questions: ["Changed question?"] },
  } });
  assert.equal(updated.status, 200);
  assert.equal(await tick(), false);
  assert.deepEqual((await getJob(pool, { ...scope, jobId, includeStepInputs: true })).input.questions, plan.configuration.questions);
  await setChannelPaused(pool, "gpt", true);
  await runJob(pool, { geo: (step) => executeGeo(step, platforms) }, { log() {} });
  assert.deepEqual(calls, ["gemini", "gemini"]);
  assert.equal((await operationalStatus(pool)).paused[0].id, "gpt");
  await setChannelPaused(pool, "gpt", false);
  await pool.query("UPDATE yaosight.jobs SET ready_at=now() WHERE id=$1", [jobId]);
  await runJob(pool, { geo: (step) => executeGeo(step, platforms) }, { log() {} });
  assert.deepEqual(calls, ["gemini", "gemini", "gpt", "gpt"]);
  assert.equal((await getJob(pool, { ...scope, jobId })).status, "succeeded");
  const drifted = {
    ...platforms,
    configuration: (id) => ({ ...platforms.configuration(id), routeFingerprint: id + "-changed" }),
  };
  const oldConfig = (await getJob(pool, { ...scope, jobId })).input.configuration.find(({ id }) => id === "gpt");
  const outcome = await executeGeo({
    input: { check: { configuration: [oldConfig] }, platformId: "gpt", number: 1 },
  }, drifted);
  assert.deepEqual(outcome, { state: "failed", units: 0, category: "model_configuration_changed" });
  assert.equal(calls.length, 4);
});

test("article workflow gates vision, preserves partial images, and publishes a scoped report", { skip: !adminUrl }, async (t) => {
  const pool = await testDatabase(t);
  const space = await bootstrapWorkspace(pool, "Content", "editor@example.com");
  const session = await createSession(pool, { issuer: origin.href, subject: "editor", email: "editor@example.com" }, tokenHash(space.token));
  const { rows: [project] } = await pool.query("INSERT INTO yaosight.projects(workspace_id,name) VALUES ($1,'Content') RETURNING id", [space.id]);
  const { rows: [sibling] } = await pool.query("INSERT INTO yaosight.projects(workspace_id,name) VALUES ($1,'Another content project') RETURNING id", [space.id]);
  const scope = { workspaceId: space.id, projectId: project.id };
  const root = "/api/workspaces/" + space.id + "/projects/" + project.id;
  const fetchToken = randomBytes(32).toString("base64url");
  const image = Buffer.from("89504e470d0a1a0a00", "hex").toString("base64");
  let reads = 0;
  const fetcher = createFetchServer({ token: fetchToken, async article() {
    reads++;
    return { title: "Guide", text: "Example article content. A useful first paragraph with a figure. [图1]",
      images: [{ number: 1, type: "image/png", base64: image }], omittedImages: 1, truncated: true };
  } });
  fetcher.listen(0, "127.0.0.1");
  await once(fetcher, "listening");
  t.after(() => new Promise((resolve) => fetcher.close(resolve)));
  const objects = new Map();
  const artifacts = {
    async put(workspace, projectId, document) {
      assert.equal(workspace, space.id); assert.equal(projectId, project.id);
      const key = "test-" + objects.size; objects.set(key, document); return key;
    },
    async read(key) { return { Body: Readable.from([objects.get(key)]) }; },
  };
  let usedVision = 0;
  const platforms = {
    list: () => [{ id: "gemini", label: "Gemini", ready: true, vision: true }],
    configuration: () => ({ id: "gemini", model: "model-v1", routeFingerprint: "channel-1" }),
    async answer(_id, _prompt, options) {
      assert.equal(options.images.length, 1);
      usedVision++;
      return { text: "## 优化建议", model: "model-v1" };
    },
  };
  const send = await client(t, pool, undefined, { platforms, artifacts, sourceReady: true });
  const submit = (key, body) => send(root + "/jobs", { token: session, method: "POST", key, body });
  const read = await submit("source", { kind: "article-source", target: { url: "https://example.com/" } });
  assert.equal(read.status, 202);
  const sourceId = (await read.json()).id;
  const handlers = createArticleHandlers(pool, platforms, {
    fetchService: "http://127.0.0.1:" + fetcher.address().port, token: fetchToken, artifacts,
  });
  await runJob(pool, handlers, { log() {} });
  const source = await getJob(pool, { ...scope, jobId: sourceId });
  assert.equal(source.steps[0].result.omittedImages, 1);
  const payload = { kind: "article-optimization", target: { title: "Guide", platform: "gemini", sourceId } };
  assert.equal((await submit("optimize", payload)).status, 409);
  await pool.query("INSERT INTO yaosight.vision_checks(platform_id,model,route_fingerprint,expires_at) VALUES ('gemini','model-v1','channel-1',now()+interval '1 day')");
  const otherPath = "/api/workspaces/" + space.id + "/projects/" + sibling.id;
  const otherReport = await send(otherPath + "/jobs", { token: session, method: "POST", key: "foreign-article", body: payload });
  assert.equal(otherReport.status, 404);
  const response = await submit("optimize", payload);
  assert.equal(response.status, 202, await response.clone().text());
  await runJob(pool, handlers, { log() {} });
  const report = await getJob(pool, { ...scope, jobId: (await response.json()).id });
  assert.equal(report.status, "succeeded");
  assert.equal(usedVision, 1);
  const downloaded = await send(root + "/reports/" + report.steps[0].result.artifact, { token: session });
  assert.equal(downloaded.status, 200);
  assert.match(await downloaded.text(), /优化建议/u);
  const geo = await submit("geo-with-article", { kind: "geo", target: {
    kind: "article", name: "Guide", url: "https://example.com/", platforms: ["gemini"],
  } });
  assert.equal(geo.status, 202, await geo.clone().text());
  const { id: checkId } = await geo.json();
  const checkURL = root + "/jobs/" + checkId + "/article";
  assert.equal((await (await send(checkURL, { token: session })).json()).status, "queued");
  assert.equal((await send(otherPath + "/jobs/" + checkId + "/article", { token: session })).status, 404);
  const combined = {
    ...handlers,
    geo: async () => ({ state: "succeeded", units: 1, result: { answer: "Guide", model: "Gemini" } }),
  };
  await runJob(pool, combined, { log() {} });
  await runJob(pool, combined, { log() {} });
  const linked = await (await send(checkURL, { token: session })).json();
  assert.equal(linked.article.imageCount, 1);
  assert.equal(linked.canUseEvidence, true);
  assert.equal(reads, 2);
  const reuse = await submit("optimize-snapshot", { kind: "article-optimization", target: { checkId, title: "Guide", platform: "gemini" } });
  assert.equal(reuse.status, 202, await reuse.clone().text());
  await runJob(pool, combined, { log() {} });
  const reused = await getJob(pool, { ...scope, jobId: (await reuse.json()).id });
  assert.equal(reused.status, "succeeded");
  assert.equal(reused.steps[0].result.checkId, checkId);
  assert.equal(usedVision, 2);
  assert.equal(reads, 2);
  await pool.query("UPDATE yaosight.vision_checks SET expires_at=now()");
  assert.equal((await submit("expired", payload)).status, 409);
});

test("site ownership gates SEO work and historical imports do not enqueue calls", { skip: !adminUrl }, async (t) => {
  const pool = await testDatabase(t);
  const space = await bootstrapWorkspace(pool, "SEO", "seo@example.com");
  const session = await createSession(pool, { issuer: origin.href, subject: "seo", email: "seo@example.com" }, tokenHash(space.token));
  const { rows: [actor] } = await pool.query("SELECT id FROM yaosight.accounts WHERE subject='seo'");
  const { rows: [project] } = await pool.query("INSERT INTO yaosight.projects(workspace_id,name) VALUES ($1,'SEO') RETURNING id", [space.id]);
  const scope = { workspaceId: space.id, projectId: project.id };
  const root = "/api/workspaces/" + space.id + "/projects/" + project.id;
  const fetchToken = randomBytes(32).toString("base64url");
  const fetcher = createFetchServer({ token: fetchToken, async crawl(input) {
    assert.equal(input.host, "example.com");
    const content = Buffer.from("mock report").toString("base64");
    return { parsed: { config: input, ruleVersion: 1, findings: [], coverage: {}, observedStatuses: {}, visited: 3 }, raw: content, html: content };
  } });
  fetcher.listen(0, "127.0.0.1");
  await once(fetcher, "listening");
  t.after(() => new Promise((resolve) => fetcher.close(resolve)));
  const artifacts = { async put() { return "test/" + randomBytes(10).toString("hex"); } };
  const send = await client(t, pool, undefined, { artifacts, sourceReady: true });
  const request = { token: session, method: "POST", key: "seo-run", body: { kind: "seo", target: { url: "https://example.com/" } } };
  assert.equal((await send(root + "/jobs", request)).status, 409);
  const challenge = await (await send(root + "/site/challenge", { token: session, method: "POST", body: { domain: "example.com" } })).json();
  await assert.rejects(verifySite(pool, scope, challenge, async () => [["wrong"]]), { status: 422 });
  await verifySite(pool, scope, challenge, async (record) => {
    assert.equal(record, "_yaosight.example.com"); return [[challenge.site_challenge]];
  });
  assert.equal((await send(root + "/jobs", { ...request, body: { kind: "seo", target: { url: "https://other.com/" } } })).status, 409);
  const queued = await send(root + "/jobs", request);
  assert.equal(queued.status, 202);
  const { id } = await queued.json();
  await runJob(pool, { seo: createSeoHandler(pool, {
    fetchService: "http://127.0.0.1:" + fetcher.address().port, token: fetchToken, artifacts,
  }) }, { log() {} });
  const result = await getJob(pool, { ...scope, jobId: id });
  assert.equal(result.status, "succeeded");
  assert.equal(result.steps[0].result.reports.length, 2);
  const oldId = "a".repeat(64);
  const history = [
    { kind: "geo", id: oldId, record: { kind: "article", name: "An old check", state: "running" } },
    { kind: "article-optimization", id: "ac2efcd2-7894-49e8-9d7a-2788267d876f", record: {
      title: "Old report", generatedAt: new Date().toISOString(), markdown: "Example", checkId: oldId,
    } },
  ];
  assert.deepEqual(await importRecords(pool, scope, actor.id, history), { imported: 2, previouslyImported: 0 });
  assert.deepEqual(await importRecords(pool, scope, actor.id, history), { imported: 0, previouslyImported: 2 });
  const { rows: old } = await pool.query("SELECT id,kind,status,baseline_id FROM yaosight.jobs WHERE input->>'historical'='true' ORDER BY kind");
  assert.equal(old.length, 2);
  assert.equal(old[0].baseline_id, old[1].id);
  assert.equal(old[1].status, "review");
  assert.equal(await claim(pool), null);
  const reportLegacy = await send(root + "/jobs/" + old[0].id + "/markdown", { token: session });
  assert.equal(reportLegacy.status, 200);
  assert.equal(await reportLegacy.text(), "Example");
  const plan = await send(root + "/monitors", { token: session, method: "POST", body: {
    name: "Weekly audit", kind: "seo", cadence: "weekly", active: true, configuration: { url: "https://example.com/" },
  } });
  assert.equal(plan.status, 200);
  const planId = (await plan.json()).id;
  assert.equal(await dueMonitor(pool, (db, scope, _kind, value) => prepareSeo(db, scope, value)), true);
  const planned = await (await send(root + "/monitors/" + planId, { token: session })).json();
  assert.equal(planned.periods.length, 1);
  assert.ok(planned.periods[0].job_id);
});
