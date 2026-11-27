import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(derive);
const defaultCookie = "yaosight_session";
const duration = 8 * 60 * 60;
const cookieFlags = "; Path=/; HttpOnly; SameSite=Strict; Max-Age=";

async function loadCredentials(path) {
  try {
    const credentials = JSON.parse(await readFile(path, "utf8"));
    if (!/^[a-f0-9]{32}$/.test(credentials?.salt || "") || !/^[a-f0-9]{128}$/.test(credentials?.digest || "")) {
      throw new Error("Invalid local account file");
    }
    return credentials;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function validLocalPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 128;
}

export async function createLocalAccount(path, password) {
  if (!validLocalPassword(password)) throw new Error("密码需为 8 至 128 个字符。");
  const salt = randomBytes(16).toString("hex");
  const digest = await scrypt(password, Buffer.from(salt, "hex"), 64);
  const record = { salt, digest: digest.toString("hex") };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  return record;
}

export async function localAuth(path, { namespace = "/api", cookie = defaultCookie, allowSetup = true } = {}) {
  let credentials = await loadCredentials(path);
  let busy = false;
  let failures = 0;
  let nextAttempt = 0;
  const sessions = new Map();

  function token(req) {
    const prefix = cookie + "=";
    const value = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix))?.slice(prefix.length);
    return /^[a-f0-9]{64}$/.test(value ?? "") ? value : undefined;
  }

  function signedIn(req) {
    const id = token(req);
    const expires = sessions.get(id);
    if (!expires || expires < Date.now()) {
      if (id) sessions.delete(id);
      return false;
    }
    return true;
  }

  function issue(res) {
    for (const [key, expiry] of sessions) if (expiry < Date.now()) sessions.delete(key);
    if (sessions.size >= 48) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, Date.now() + duration * 1000);
    res.setHeader("Set-Cookie", cookie + "=" + id + cookieFlags + duration);
  }

  async function handle(req, res, pathName, input, json, origin) {
    if (!credentials && !allowSetup) credentials = await loadCredentials(path);
    if (req.method === "GET" && pathName === namespace + "/session") {
      const status = allowSetup ? { needsSetup: !credentials } : { configured: Boolean(credentials) };
      return json(res, 200, { signedIn: signedIn(req), ...status });
    }
    if (req.method !== "POST") return json(res, 405, { error: "不支持此请求。" });
    if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== origin)) {
      return json(res, 403, { error: "来源不符。" });
    }
    if (pathName === namespace + "/logout") {
      sessions.delete(token(req));
      res.setHeader("Set-Cookie", cookie + "=" + cookieFlags + "0");
      return json(res, 200, { signedIn: false });
    }
    const setup = allowSetup && pathName === namespace + "/setup";
    if (pathName !== namespace + "/login" && !setup) return json(res, 404, { error: "页面不存在。" });
    if (busy || Date.now() < nextAttempt) return json(res, 429, { error: "请稍等片刻后重试。" });
    let payload;
    try { payload = await input(req); }
    catch { return json(res, 400, { error: "请求格式无效。" }); }
    const password = payload.password;
    if ((setup && credentials) || (!setup && !credentials)) {
      return json(res, 409, { error: allowSetup ? "账号状态已更新，请刷新页面。" : "请先在本机终端创建管理员账号。" });
    }
    if (!validLocalPassword(password)) {
      return json(res, 400, { error: "请输入 8 至 128 个字符的密码。" });
    }
    if (setup && password !== payload.confirm) return json(res, 400, { error: "两次输入的密码不一致。" });
    if (busy || Date.now() < nextAttempt) return json(res, 429, { error: "请稍等片刻后重试。" });
    busy = true;
    try {
      if (setup) {
        credentials = await createLocalAccount(path, password);
      } else {
        const digest = await scrypt(password, Buffer.from(credentials.salt, "hex"), 64);
        if (!timingSafeEqual(digest, Buffer.from(credentials.digest, "hex"))) {
          failures += 1;
          if (failures >= 5) nextAttempt = Date.now() + Math.min(30000, 1000 * (failures - 4));
          return json(res, 401, { error: "密码不正确，请重试。" });
        }
      }
      failures = 0;
      nextAttempt = 0;
      issue(res);
      return json(res, 200, { signedIn: true });
    } finally {
      busy = false;
    }
  }
  return { handle, signedIn };
}
