import { createHash } from "node:crypto";
import { ProviderCatalog } from "./vendor/niubigeo/dist/src/providers/catalog.js";
import { OpenAICompatibleProvider } from "./vendor/niubigeo/dist/src/providers/openai-compatible.js";
import { ResponsesCompatibleProvider } from "./vendor/niubigeo/dist/src/providers/responses-compatible.js";
import { normalizeCustomBaseUrl, withCustomConnection } from "./vendor/niubigeo/dist/src/providers/custom-connection.js";
import { withProviderHttpAttempts } from "./vendor/niubigeo/dist/src/providers/http.js";
import { withRequestProviderKeys } from "./vendor/niubigeo/dist/src/config/env.js";

const entries = [
  { id: "doubao", label: "豆包", key: "ARK_API_KEY", modelKey: "DOUBAO_MODEL", endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions" },
  { id: "qwen", label: "千问", key: "DASHSCOPE_API_KEY", modelKey: "QWEN_MODEL", model: "qwen-plus", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" },
  { id: "gpt", label: "GPT", key: "OPENAI_API_KEY", modelKey: "GPT_MODEL", model: "gpt-4.1-mini", provider: "openai", search: true },
  { id: "gemini", label: "Gemini", key: "GEMINI_API_KEY", modelKey: "GEMINI_MODEL", model: "gemini-3-flash-preview", provider: "gemini", search: true },
  { id: "deepseek", label: "DeepSeek", key: "DEEPSEEK_API_KEY", modelKey: "DEEPSEEK_MODEL", model: "deepseek-chat", provider: "deepseek" },
  { id: "wenxin", label: "百度 AI（文心）", key: "QIANFAN_API_KEY", modelKey: "WENXIN_MODEL", endpoint: "https://qianfan.baidubce.com/v2/chat/completions" },
];

export function createGeoPlatforms(env = process.env) {
  const catalog = new ProviderCatalog();
  const lastSuccess = new Map();
  const rawBaseUrl = env.GEO_RELAY_BASE_URL?.trim();
  let baseUrl = rawBaseUrl ? normalizeCustomBaseUrl(rawBaseUrl) : undefined;
  if (baseUrl && new URL(baseUrl).pathname === "/") baseUrl += "/v1";

  const configured = new Map(entries.map((entry) => {
    const { id, label, key, modelKey } = entry;
    const relayPrefix = id.toUpperCase() + "_RELAY_";
    const relayKey = env[relayPrefix + "API_KEY"]?.trim();
    const relay = relayKey && baseUrl ? { baseUrl } : undefined;
    const endpoint = relay ? baseUrl + "/chat/completions" : entry.endpoint;
    const provider = endpoint ? new OpenAICompatibleProvider({
      definition: { id, label, sourceType: "api", supportsWebSearch: false },
      endpoint,
      ...(relay && { endpointKind: "custom_gateway" }),
    }) : catalog.get(entry.provider);
    const relaySearch = relay && env[relayPrefix + "SEARCH"] === "on" ? new ResponsesCompatibleProvider({
      definition: { ...provider.definition, supportsWebSearch: true },
      endpoint: baseUrl + "/responses",
      endpointKind: "custom_gateway",
    }) : undefined;
    return [id, {
      id, label, provider, relay, relaySearch,
      key: relayKey ? (relay && relayKey) : env[key]?.trim(),
      model: relay ? env[relayPrefix + "MODEL"]?.trim() : env[modelKey]?.trim() || entry.model,
      search: Boolean(relaySearch || (!relayKey && entry.search && env[modelKey + "_SEARCH"] !== "off")),
      vision: Boolean(relay && env[relayPrefix + "VISION"] === "on"),
      routeFingerprint: createHash("sha256").update(JSON.stringify([provider.definition.id, endpoint || null, Boolean(relay)])).digest("hex"),
    }];
  }));

  function list() {
    return Array.from(configured.values(), ({ id, label, key, model, search, vision }) =>
      ({ id, label, ready: Boolean(key && model), search, vision, lastSuccessAt: lastSuccess.get(id) }));
  }

  function configuration(id) {
    const { model, search, routeFingerprint, relay } = configured.get(id);
    return { id, model, search, routeFingerprint, channelType: relay ? "relay-api" : "direct-api" };
  }

  async function answer(id, prompt, { maxTokens = 2000, webSearch, images = [] } = {}) {
    const entry = configured.get(id);
    if (!entry?.key || !entry.model) throw new Error("Missing platform configuration");
    const search = !images.length && (webSearch ?? entry.search);
    if (search && !entry.search) throw new Error("The configured model does not support web search");
    let provider = search && entry.relaySearch ? entry.relaySearch : entry.provider;
    if (images.length) {
      if (!entry.vision) throw new Error("The configured model does not accept images");
      const content = [{ type: "text", text: prompt }];
      for (const { number, dataUrl } of images) {
        content.push({ type: "text", text: "[图" + number + "]" }, { type: "image_url", image_url: { url: dataUrl } });
      }
      provider = new OpenAICompatibleProvider({
        definition: provider.definition, endpoint: provider.endpoint, endpointKind: provider.endpointKind,
        extraBody: { messages: [{ role: "user", content }] },
      });
    }
    const run = () => withProviderHttpAttempts(1, () =>
      withRequestProviderKeys({ [provider.definition.id]: entry.key }, () => provider.run({
        apiKey: entry.key,
        model: entry.model,
        prompt,
        maxTokens,
        temperature: 0.7,
        webSearchEnabled: search,
        ...(search && { webSearchMode: "provider_native" }),
      })));
    const response = await (entry.relay ? withCustomConnection(entry.relay, run) : run());
    if (response.text?.trim()) lastSuccess.set(id, new Date().toISOString());
    if (!search || !entry.relaySearch) return response;
    const completedSearch = response.rawProviderResponse?.output?.some((item) =>
      item?.type === "web_search_call" && item.status === "completed") === true;
    return { ...response, search: { ...response.search, used: completedSearch } };
  }

  return { list, configuration, answer };
}
