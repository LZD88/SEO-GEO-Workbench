import * as oidc from "openid-client";
import { HttpError } from "./http.mjs";
import { createSession, isSecretToken, secretToken, tokenHash } from "./workspaces.mjs";

const sessionCookie = "__Host-yaosight_session";
const flowCookie = "__Host-yaosight_flow";

function cookie(req, name) {
  const prefix = name + "=";
  return req.headers.cookie?.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(prefix))?.slice(prefix.length);
}

function setCookie(name, value, seconds) {
  return name + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + seconds;
}

function redirect(res, location, cookies) {
  res.writeHead(303, { Location: location, "Set-Cookie": cookies, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
}

export function createOidc({ issuer, clientId, clientSecret }) {
  if (!issuer || !clientId || !clientSecret) throw new Error("OIDC configuration is required");
  if (new URL(issuer).protocol !== "https:") throw new Error("OIDC issuer must use HTTPS");
  let settings;
  return async () => {
    settings ??= oidc.discovery(new URL(issuer), clientId, { client_secret: clientSecret }, oidc.ClientSecretBasic(clientSecret))
      .then((config) => { oidc.enableNonRepudiationChecks(config); return config; })
      .catch((error) => { settings = undefined; throw error; });
    return settings;
  };
}

export function createAuth({ pool, origin, settings }) {
  const callback = new URL("/auth/callback", origin);

  async function begin(req, res, url) {
    const invitation = url.searchParams.get("invite");
    if (invitation !== null && !isSecretToken(invitation)) throw new HttpError(400, "邀请链接无效。");
    const config = await settings();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = secretToken();
    const nonce = oidc.randomNonce();
    await pool.query(`
      INSERT INTO yaosight.login_flows (state_hash, verifier, nonce, invitation_hash, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '5 minutes')
    `, [tokenHash(state), verifier, nonce, invitation ? tokenHash(invitation) : null]);
    const to = oidc.buildAuthorizationUrl(config, {
      redirect_uri: callback.href,
      scope: "openid email",
      code_challenge_method: "S256",
      code_challenge: challenge,
      nonce,
      state,
    });
    redirect(res, to.href, setCookie(flowCookie, state, 300));
  }

  async function complete(req, res, url) {
    const state = url.searchParams.get("state");
    if (!isSecretToken(state) || state !== cookie(req, flowCookie)) throw new HttpError(403, "登录已过期，请重新进入。");
    const { rows: [flow] } = await pool.query(`
      DELETE FROM yaosight.login_flows WHERE state_hash=$1 AND expires_at>now()
      RETURNING verifier, nonce, invitation_hash
    `, [tokenHash(state)]);
    if (!flow) throw new HttpError(403, "登录已过期，请重新进入。");

    const config = await settings();
    let claims, info;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: flow.verifier, expectedNonce: flow.nonce, expectedState: state, idTokenExpected: true,
      });
      claims = tokens.claims();
      info = claims?.email_verified === true && claims.email
        ? claims
        : await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    } catch {
      throw new HttpError(403, "身份提供方未完成登录，请重新进入。");
    }
    if (info.email_verified !== true || !info.email || !claims.sub) throw new HttpError(403, "请使用已验证邮箱登录。");
    const value = await createSession(pool, { issuer: claims.iss, subject: claims.sub, email: info.email }, flow.invitation_hash);
    await revoke(req);
    redirect(res, "/", [setCookie(flowCookie, "", 0), setCookie(sessionCookie, value, 8 * 3600)]);
  }

  async function session(req) {
    const value = cookie(req, sessionCookie);
    if (!isSecretToken(value)) return null;
    const { rows: [user] } = await pool.query(`
      SELECT a.id, a.email FROM yaosight.sessions s
      JOIN yaosight.accounts a ON a.id=s.account_id
      WHERE s.token_hash=$1 AND s.expires_at>now()
    `, [tokenHash(value)]);
    return user ?? null;
  }

  async function revoke(req) {
    const value = cookie(req, sessionCookie);
    if (isSecretToken(value)) await pool.query("DELETE FROM yaosight.sessions WHERE token_hash=$1", [tokenHash(value)]);
  }

  async function logout(req, res) {
    await revoke(req);
    redirect(res, "/", setCookie(sessionCookie, "", 0));
  }

  return { begin, complete, session, logout };
}
