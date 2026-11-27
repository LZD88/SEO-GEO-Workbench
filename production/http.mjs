export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export function requireSameOrigin(req, origin) {
  if (req.headers.origin !== origin.origin || req.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "请求来源不符。");
  }
}

export async function readJson(req, maxBytes = 8192) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HttpError(415, "仅接受 JSON 请求。");
  }
  if (Number(req.headers["content-length"]) > maxBytes) throw new HttpError(413, "请求太大。");
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "请求太大。");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch { /* Malformed JSON is reported below. */ }
  throw new HttpError(400, "请求格式无效。");
}

export const isUuid = (value) => typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function nameField(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100) throw new HttpError(400, "名称长度须为 1 至 100 个字符。");
  return name;
}
