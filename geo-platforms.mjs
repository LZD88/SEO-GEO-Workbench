import { ProviderCatalog } from "./vendor/niubigeo/dist/src/providers/catalog.js";
import { OpenAICompatibleProvider } from "./vendor/niubigeo/dist/src/providers/openai-compatible.js";
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
  const configured = new Map(entries.map((entry) => {
    const { id, label, key, modelKey, endpoint } = entry;
    const provider = endpoint ? new OpenAICompatibleProvider({
      definition: { id, label, sourceType: "api", supportsWebSearch: false },
      endpoint,
    }) : catalog.get(entry.provider);
    return [id, {
      id, label, provider, key: env[key]?.trim(),
      model: env[modelKey]?.trim() || entry.model,
      search: Boolean(entry.search && env[modelKey + "_SEARCH"] !== "off"),
    }];
  }));

  function list() {
    return Array.from(configured.values(), ({ id, label, key, model, search }) =>
      ({ id, label, ready: Boolean(key && model), search }));
  }

  function answer(id, prompt) {
    const entry = configured.get(id);
    if (!entry?.key || !entry.model) throw new Error("Missing platform configuration");
    return withProviderHttpAttempts(1, () => withRequestProviderKeys({ [entry.provider.definition.id]: entry.key }, () => entry.provider.run({
      apiKey: entry.key,
      model: entry.model,
      prompt,
      maxTokens: 2000,
      temperature: 0.7,
      webSearchEnabled: entry.search,
      ...(entry.search && { webSearchMode: "provider_native" }),
    })));
  }

  return { list, answer };
}
