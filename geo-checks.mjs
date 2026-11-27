import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { containsConfiguredIdentity } from "./vendor/niubigeo/dist/src/prompts/brand-question.js";
import { KeywordMonitorStore } from "./vendor/niubigeo/dist/src/product/keyword-monitor-store.js";
import { ProductProjectFileStore } from "./vendor/niubigeo/dist/src/product/projects/project-store.js";

const checkIdPattern = /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const promptVersion = 1;
const trackingParameters = new Set(["gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "igshid", "gbraid", "wbraid"]);

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
  for (const name of new Set(copy.searchParams.keys())) {
    if (name.toLowerCase().startsWith("utm_") || trackingParameters.has(name.toLowerCase())) copy.searchParams.delete(name);
  }
  copy.searchParams.sort();
  return copy.host.toLowerCase() + copy.pathname + copy.search;
}

function classify(sample, kind) {
  if (sample.pending) return "pending";
  if (sample.error) return "failed";
  if (kind === "brand") return sample.mentioned ? "mentioned" : "miss";
  if (sample.cited) return "citation";
  return sample.textMatch ? "text-link" : "miss";
}

const failures = {
  authentication: "服务未通过认证，请联系管理员。",
  billing: "模型额度不足，请联系管理员。",
  rate_limited: "模型请求过多，请稍后重试。",
  unsupported_capability: "模型不支持当前检测配置，请联系管理员。",
  invalid_response: "模型拒绝了这项请求，请联系管理员。",
  empty_answer: "模型未返回可用回答。",
};

export function modelFailureMessage(error) {
  if (error?.name === "AbortError" || error?.code === "timeout") return "模型响应超时，请稍后重试。";
  if (error?.status === 403 && /all available accounts exhausted/i.test(error.message)) {
    return "中转站当前没有可用的上游账号，请稍后重试。";
  }
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
    const { id, kind, name, url, question, createdAt, baselineId, comparisonMode } = row;
    return { id, kind, name, url, question, createdAt, baselineId, comparisonMode, sampleCount: row.sampleCount ?? 1, state: stateOf(row) };
  }

  async function list(limit = 30) {
    await mkdir(dataDir, { recursive: true });
    const names = (await readdir(dataDir)).filter((name) => /^(?:[a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(name));
    const rows = await Promise.all(names.map((name) => read(name.slice(0, -5))));
    return rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(summary);
  }

  async function sample(check, platform, number, search) {
    const identity = { platformId: platform.id, model: platform.label, number };
    try {
      const prompt = "请用简体中文回答以下问题。有可靠来源时请给出链接；不确定时请明确说明。\n\n" + check.question;
      const response = await platforms.answer(platform.id, prompt, { webSearch: search });
      const answer = response.text?.trim();
      if (!answer) return { ...identity, error: "模型未返回可用回答。" };
      const sources = response.citations.flatMap((citation) => {
        const url = sourceUrl(citation.url);
        return url ? [{ url: url.href, type: citation.source === "answer_text_url" ? "text" : "citation" }] : [];
      });
      const matches = sources.filter((source) => citationKey(source.url) === citationKey(check.url));
      const reportedModel = response.rawProviderResponse?.modelVersion ?? response.rawProviderResponse?.model;
      const modelVersion = typeof reportedModel === "string" ? reportedModel.trim().slice(0, 150) : undefined;
      return {
        ...identity,
        modelVersion,
        answer: answer.slice(0, 16000),
        sources: [...matches, ...sources.filter((source) => !matches.includes(source))].slice(0, 25),
        mentioned: check.kind === "brand" && containsConfiguredIdentity(answer, check.name),
        cited: matches.some((source) => source.type === "citation"),
        textMatch: matches.some((source) => source.type === "text"),
        usedSearch: response.search?.used, measuredAt: new Date().toISOString(),
      };
    } catch (error) {
      return { ...identity, error: modelFailureMessage(error), measuredAt: new Date().toISOString() };
    }
  }

  async function execute(check, selected) {
    try {
      await Promise.all(selected.map(async (platform) => {
        const { search } = check.configuration.find(({ id }) => id === platform.id);
        for (const [index, row] of check.samples.entries()) {
          if (row.platformId === platform.id && row.pending) {
            check.samples[index] = await sample(check, platform, row.number, search);
          }
        }
      }));
      const state = check.samples.every((result) => result.error) ? "failed" : "completed";
      const measuredAt = new Date().toISOString();
      const staging = file(check.id) + ".tmp";
      await writeFile(staging, JSON.stringify({ ...check, state, measuredAt }, null, 2) + "\n");
      await rename(staging, file(check.id));
      check.state = state;
      check.measuredAt = measuredAt;
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
    const count = payload.sampleCount ?? 1;
    if (![1, 3, 5].includes(count)) throw new GeoError(400, "每个平台的采样次数只能选 1、3 或 5 次。");
    if (payload.webSearch !== undefined && typeof payload.webSearch !== "boolean") throw new GeoError(400, "联网选项无效。");
    const selected = ids.map((id) => available.get(id));
    if (payload.webSearch && !selected.some((item) => item.ready && item.search)) {
      throw new GeoError(400, "请至少选择一个支持联网的模型。");
    }
    return start(values, selected, { count, webSearch: payload.webSearch === true });
  }

  async function start(values, selected, { count, webSearch = false, baseline, comparisonMode }) {
    const unavailable = selected.filter((entry) => !entry.ready);
    if (unavailable.length) {
      throw new GeoError(409, unavailable.map((entry) => entry.label).join("、") + "尚未配置，请联系管理员。");
    }
    if (running) throw new GeoError(409, "已有一项 GEO 检测正在运行。");
    const configuration = baseline?.configuration?.length ? baseline.configuration : selected.map(({ id, search }) => ({
      ...platforms.configuration(id), search: webSearch && search === true,
    }));
    const pendingSample = ({ id, label }, number) => ({ platformId: id, model: label, number, pending: true });
    const samples = comparisonMode === "retry"
      ? baseline.samples.map((row) => {
        const platform = selected.find(({ id, label }) => row.platformId ? id === row.platformId : label === row.model);
        return row.error ? pendingSample(platform, row.number ?? 1) : { ...row, retained: true };
      })
      : selected.flatMap((platform) => Array.from({ length: count }, (_, index) => pendingSample(platform, index + 1)));
    const check = {
      ...values, id: randomUUID(), state: "running", createdAt: new Date().toISOString(),
      promptVersion, configuration, baselineId: baseline?.id, comparisonMode, sampleCount: count, samples,
    };
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

  function previousPlatforms(row, available) {
    if (row.configuration?.length) return row.configuration.map(({ id }) => id);
    if (!row.samples?.length) return [];
    const ids = row.samples.map((sample) =>
      available.find(({ id, label }) => sample.platformId ? id === sample.platformId : label === sample.model)?.id);
    return ids.includes(undefined) || new Set(ids).size !== ids.length ? [] : ids;
  }

  async function retest(id, useCurrentConfiguration, failedOnly = false) {
    if (typeof id !== "string" || !checkIdPattern.test(id)) throw new GeoError(400, "复测基线无效。");
    const row = await read(id);
    if (!row) throw new GeoError(404, "检测记录不存在。");
    if (!["completed", "failed"].includes(row.state)) throw new GeoError(409, "这条检测记录尚未结束或已中断。");
    const available = platforms.list();
    if (failedOnly && (!row.configuration?.length || !row.samples?.some((item) => item.error))) {
      throw new GeoError(409, "这条记录没有可按原配置补跑的失败样本。");
    }
    const ids = failedOnly ? [...new Set(row.samples.filter((item) => item.error).map((sample) =>
      sample.platformId || available.find(({ label }) => label === sample.model)?.id))] : previousPlatforms(row, available);
    if (!ids.length) throw new GeoError(409, "旧记录缺少可识别的平台，请新建检测。");
    if (row.configuration?.length) {
      const mismatch = row.promptVersion !== promptVersion || ids.some((id) => {
        const before = row.configuration.find((item) => item.id === id);
        if (!before) return true;
        const platform = available.find(({ id }) => id === before.id);
        if (!platform?.ready) return true;
        const after = platforms.configuration(before.id);
        return before.model !== after.model || (before.search && !after.search) || before.routeFingerprint !== after.routeFingerprint;
      });
      if (mismatch) throw new GeoError(409, "模型、联网或渠道配置已变化，无法按原条件复测。");
    } else if (useCurrentConfiguration !== true) {
      throw new GeoError(409, "旧记录缺少配置快照，请选择按当前配置复测。");
    }
    const { kind, name, url, question } = row;
    return start(normalize({ kind, name, url, question }), ids.map((id) => available.find((item) => item.id === id)), {
      count: row.sampleCount ?? 1, baseline: row, comparisonMode: failedOnly ? "retry" : row.configuration?.length ? "matched" : "legacy",
    });
  }

  async function result(id) {
    const row = running?.id === id ? running : await read(id);
    if (!row) throw new GeoError(404, "检测记录不存在。");
    if (row.state) {
      const available = platforms.list();
      const config = new Map(row.configuration?.map((item) => [item.id, item]));
      const samples = (row.samples || []).map((sample) => {
        const platformId = sample.platformId || available.find(({ label }) => label === sample.model)?.id;
        const configured = config.get(platformId);
        return {
          ...sample, platformId, configuredModel: configured?.model, searchRequested: configured?.search,
          evidence: classify(sample, row.kind),
        };
      });
      const retestMode = ["completed", "failed"].includes(row.state) && previousPlatforms(row, available).length
        ? (config.size ? "matched" : "legacy") : undefined;
      const canRetry = retestMode === "matched" && samples.some((sample) => sample.error);
      return { ...summary(row), samples, measuredAt: row.measuredAt, retestMode, canRetry };
    }

    const [last] = await legacy.listRuns(row.projectId, row.monitorId);
    if (!last) return { ...summary(row), state: "pending", samples: [] };
    return {
      ...summary(row),
      state: last.status,
      measuredAt: last.completedAt || last.startedAt,
      samples: (last.modelResults || []).map((sample, index) => {
        const evidence = {
          model: "历史样本 " + (index + 1),
          error: sample.error || !sample.answer ? "该历史样本未完成。" : undefined,
          mentioned: (sample.mentioned || []).length > 0,
          textMatch: (sample.citations || []).some((raw) => {
            const url = sourceUrl(raw);
            return url && citationKey(url) === citationKey(row.url);
          }),
          usedSearch: sample.searchUsed,
        };
        return { ...evidence, evidence: classify(evidence, row.kind) };
      }),
    };
  }

  return { create, list, result, retest };
}

