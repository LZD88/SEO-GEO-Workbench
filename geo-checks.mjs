import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { containsConfiguredIdentity } from "./vendor/niubigeo/dist/src/prompts/brand-question.js";
import { KeywordMonitorStore } from "./vendor/niubigeo/dist/src/product/keyword-monitor-store.js";
import { ProductProjectFileStore } from "./vendor/niubigeo/dist/src/product/projects/project-store.js";

export class GeoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function textField(value, name, limit, min = 1) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (clean.length < min || clean.length > limit) {
    throw new GeoError(400, min > 1 ? name + "需要 " + min + " 到 " + limit + " 个字符。" : "请填写有效的" + name + "。");
  }
  return clean;
}

function website(value) {
  const raw = textField(value, "网址", 2048);
  let url;
  try { url = new URL(raw); }
  catch { throw new GeoError(400, "请输入完整的 HTTP 或 HTTPS 网址。"); }
  const domain = url.hostname.replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(domain.replace(/^\[|\]$/g, "")) || !domain.includes(".") ||
      /\.(?:localhost|local|internal|test|invalid|onion)$/i.test(domain)) {
    throw new GeoError(400, "请输入公开网站的 HTTP 或 HTTPS 网址。");
  }
  url.hostname = domain;
  url.hash = "";
  return url;
}

function normalize(payload) {
  const { kind } = payload;
  if (!["article", "brand"].includes(kind)) throw new GeoError(400, "请选择检测类型。");
  const article = kind === "article";
  const name = textField(payload.name, article ? "文章标题" : "品牌名称", article ? 180 : 120);
  const url = website(payload.url);
  const question = article && (payload.question === undefined || (typeof payload.question === "string" && !payload.question.trim()))
    ? "有哪些公开资料能帮助理解「" + name + "」这个主题？有可靠来源时请附上引用。"
    : textField(payload.question, "检测问题", 240, 2);
  return { kind, name, url: url.href, question };
}

function sourceUrl(raw) {
  try {
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* Provider supplied an invalid citation. */ }
}

function citationKey(url) {
  const copy = new URL(url);
  copy.searchParams.sort();
  return copy.hostname.toLowerCase() + copy.pathname + copy.search;
}

const failures = {
  authentication: "服务未通过认证，请联系管理员。",
  billing: "模型额度不足，请联系管理员。",
  rate_limited: "模型请求过多，请稍后重试。",
  unsupported_capability: "模型不支持当前检测配置，请联系管理员。",
  invalid_response: "模型拒绝了这项请求，请联系管理员。",
  empty_answer: "模型未返回可用回答。",
};

function failureMessage(error) {
  if (error?.name === "AbortError" || error?.code === "timeout") return "模型响应超时，请稍后重试。";
  return Object.hasOwn(failures, error?.code) ? failures[error.code] : "模型暂时无法完成检测，请稍后重试。";
}

export function createGeoChecks({ dataDir, legacyDataDir, platforms }) {
  const legacy = new KeywordMonitorStore(new ProductProjectFileStore(legacyDataDir));
  let running;
  const file = (id) => join(dataDir, id + ".json");

  async function read(id) {
    try { return JSON.parse(await readFile(file(id), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function stateOf(row) {
    if (row.state === "running" && running?.id !== row.id) return "interrupted";
    return row.state || "legacy";
  }

  function summary(row) {
    const { id, kind, name, url, question, createdAt } = row;
    return { id, kind, name, url, question, createdAt, state: stateOf(row) };
  }

  async function list(limit = 30) {
    await mkdir(dataDir, { recursive: true });
    const names = (await readdir(dataDir)).filter((name) => /^(?:[a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(name));
    const rows = await Promise.all(names.map((name) => read(name.slice(0, -5))));
    return rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(summary);
  }

  async function sample(check, platform) {
    try {
      const prompt = "请用简体中文回答以下问题。有可靠来源时请给出链接；不确定时请明确说明。\n\n" + check.question;
      const response = await platforms.answer(platform.id, prompt);
      const answer = response.text?.trim();
      if (!answer) return { model: platform.label, error: "模型未返回可用回答。" };
      const sources = response.citations.flatMap((citation) => {
        const url = sourceUrl(citation.url);
        return url ? [{ url: url.href, type: citation.source === "answer_text_url" ? "text" : "citation" }] : [];
      });
      const matches = sources.filter((source) => citationKey(source.url) === citationKey(check.url));
      return {
        model: platform.label,
        answer: answer.slice(0, 16000),
        sources: sources.slice(0, 25),
        mentioned: check.kind === "brand" && containsConfiguredIdentity(answer, check.name),
        cited: matches.some((source) => source.type === "citation"),
        textMatch: matches.some((source) => source.type === "text"),
        usedSearch: response.search?.used === true,
      };
    } catch (error) {
      return { model: platform.label, error: failureMessage(error) };
    }
  }

  async function execute(check, selected) {
    try {
      await Promise.all(selected.map(async (platform, index) => {
        check.samples[index] = await sample(check, platform);
      }));
      check.state = check.samples.every((result) => result.error) ? "failed" : "completed";
      check.measuredAt = new Date().toISOString();
      const staging = file(check.id) + ".tmp";
      await writeFile(staging, JSON.stringify(check, null, 2) + "\n");
      await rename(staging, file(check.id));
    } catch {
      console.error("无法保存 GEO 检测结果。");
    } finally {
      running = undefined;
    }
  }

  async function create(payload) {
    const values = normalize(payload);
    const ids = payload.platforms;
    const available = new Map(platforms.list().map((entry) => [entry.id, entry]));
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > available.size ||
        new Set(ids).size !== ids.length || ids.some((id) => !available.has(id))) {
      throw new GeoError(400, "请选择六个平台中的至少一个。");
    }
    const selected = ids.map((id) => available.get(id));
    const unavailable = selected.filter((entry) => !entry.ready);
    if (unavailable.length) {
      throw new GeoError(409, unavailable.map((entry) => entry.label).join("、") + "尚未配置，请联系管理员。");
    }
    if (running) throw new GeoError(409, "已有一项 GEO 检测正在运行。");
    const status = selected.map((platform) => ({ model: platform.label, pending: true }));
    const check = { ...values, id: randomUUID(), state: "running", createdAt: new Date().toISOString(), samples: status };
    running = check;
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file(check.id), JSON.stringify(check, null, 2) + "\n", { flag: "wx" });
    } catch (error) {
      running = undefined;
      throw error;
    }
    void execute(check, selected);
    return summary(check);
  }

  async function result(id) {
    const row = running?.id === id ? running : await read(id);
    if (!row) throw new GeoError(404, "检测记录不存在。");
    if (row.state) return { ...summary(row), samples: row.samples, measuredAt: row.measuredAt };

    const [last] = await legacy.listRuns(row.projectId, row.monitorId);
    if (!last) return { ...summary(row), state: "pending", samples: [] };
    return {
      ...summary(row),
      state: last.status,
      measuredAt: last.completedAt || last.startedAt,
      samples: (last.modelResults || []).map((sample, index) => ({
        model: "历史样本 " + (index + 1),
        error: sample.error || !sample.answer ? "该历史样本未完成。" : undefined,
        mentioned: (sample.mentioned || []).length > 0,
        textMatch: (sample.citations || []).some((raw) => {
          const url = sourceUrl(raw);
          return url && citationKey(url) === citationKey(row.url);
        }),
        usedSearch: sample.searchUsed === true,
      })),
    };
  }

  return { create, list, result };
}

