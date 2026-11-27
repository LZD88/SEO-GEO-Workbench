const maxFeedBytes = 2 * 1024 * 1024;

const feeds = [
  { id: "openai", label: "OpenAI News", url: "https://openai.com/news/rss.xml" },
  { id: "deepmind", label: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml" },
  { id: "techcrunch", label: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { id: "decoder", label: "The Decoder", url: "https://the-decoder.com/feed/" },
];

const communitySource = {
  id: "hacker-news",
  label: "Hacker News",
  url: "https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&numericFilters=points%3E%3D20&hitsPerPage=50",
};

const toolSource = {
  id: "github",
  label: "GitHub AI 工具",
  url: "https://api.github.com/search/repositories?q=topic%3Aai-tools%20stars%3A%3E50&sort=updated&order=desc&per_page=30",
};

function decodeEntities(value = "") {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
    const point = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}
function cleanText(value = "", limit = 220) {
  const text = decodeEntities(value)
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

function tag(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return match?.[1] ?? "";
}

function safeUrl(value) {
  try {
    const url = new URL(cleanText(value, 4096));
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function parseFeed(xml, source) {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0, 10);
  return blocks.flatMap(([, kind, block], index) => {
    const linkTag = kind.toLowerCase() === "entry"
      ? /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block)?.[1] || tag(block, "link")
      : tag(block, "link");
    const url = safeUrl(linkTag || tag(block, "guid"));
    const title = cleanText(tag(block, "title"), 180);
    if (!url || !title) return [];
    const publishedAt = cleanText(tag(block, "pubDate") || tag(block, "published") || tag(block, "updated"), 80);
    const parsedDate = Date.parse(publishedAt);
    return [{
      id: source.id + "-" + index,
      title,
      url,
      source: source.label,
      publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
      summary: cleanText(tag(block, "description") || tag(block, "summary") || tag(block, "content:encoded")),
    }];
  });
}

async function responseText(response) {
  if (!response.ok) throw new Error("HTTP " + response.status);
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > maxFeedBytes) throw new Error("响应过大");
  const text = await response.text();
  if (Buffer.byteLength(text) > maxFeedBytes) throw new Error("响应过大");
  return text;
}

function requestOptions() {
  return {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json, application/rss+xml, application/xml, text/xml", "User-Agent": "YaoSight-AI-Radar/0.1" },
  };
}

async function readFeed(fetcher, source) {
  const response = await fetcher(source.url, requestOptions());
  const items = parseFeed(await responseText(response), source);
  if (!items.length) throw new Error("没有可读条目");
  return items;
}

async function readCommunity(fetcher) {
  const response = await fetcher(communitySource.url, requestOptions());
  const payload = JSON.parse(await responseText(response));
  const aiTopic = /\b(ai|llm|gpt|agent|agents|openai|anthropic|gemini|deepmind|machine learning|artificial intelligence)\b/i;
  return (Array.isArray(payload.hits) ? payload.hits : [])
    .filter((item) => aiTopic.test(item.title || ""))
    .map((item) => ({
      id: "hn-" + item.objectID,
      title: cleanText(item.title, 180),
      url: safeUrl(item.url) || "https://news.ycombinator.com/item?id=" + item.objectID,
      discussionUrl: "https://news.ycombinator.com/item?id=" + item.objectID,
      source: communitySource.label,
      publishedAt: Number.isFinite(Date.parse(item.created_at)) ? new Date(item.created_at).toISOString() : null,
      points: Number(item.points) || 0,
      comments: Number(item.num_comments) || 0,
    }))
    .filter((item) => item.title && item.url)
    .sort((a, b) => b.points + b.comments * 2 - (a.points + a.comments * 2))
    .slice(0, 8);
}

async function readTools(fetcher) {
  const response = await fetcher(toolSource.url, requestOptions());
  const payload = JSON.parse(await responseText(response));
  const unwanted = /\b(vpn|proxy|keygen|crack|cheat|casino|betting)\b|翻墙|机场|破解/i;
  return (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
    const url = safeUrl(item.html_url);
    const title = cleanText(item.name || item.full_name, 100);
    if (!url || !title || unwanted.test([item.name, item.full_name, item.description].join(" "))) return [];
    return [{
      id: "github-" + item.id,
      title,
      url,
      source: item.full_name,
      publishedAt: Number.isFinite(Date.parse(item.pushed_at)) ? new Date(item.pushed_at).toISOString() : null,
      summary: cleanText(item.description || "开源 AI 工具", 180),
      stars: Number(item.stargazers_count) || 0,
      language: cleanText(item.language || "", 30),
    }];
  }).slice(0, 9);
}

function sourceResult(source, kind, cached, error) {
  return {
    id: source.id,
    label: source.label,
    kind,
    ok: !error,
    stale: Boolean(error && cached?.items.length),
    updatedAt: cached?.fetchedAt ? new Date(cached.fetchedAt).toISOString() : null,
    ...(error && { error: error.message }),
  };
}

export function createAiRadar({ fetcher = fetch, now = Date.now, ttl = 15 * 60_000, refreshFloor = 60_000 } = {}) {
  const cache = new Map();

  async function load(source, kind, reader, force) {
    const previous = cache.get(source.id);
    const time = now();
    const recent = previous && time - previous.lastAttempt < (force ? refreshFloor : ttl);
    if (recent) return { items: previous.items, source: sourceResult(source, kind, previous, previous.error) };
    try {
      const items = await reader(fetcher, source);
      const next = { items, fetchedAt: time, lastAttempt: time };
      cache.set(source.id, next);
      return { items, source: sourceResult(source, kind, next) };
    } catch (error) {
      const next = { items: previous?.items || [], fetchedAt: previous?.fetchedAt, lastAttempt: time, error };
      cache.set(source.id, next);
      return { items: next.items, source: sourceResult(source, kind, next, error) };
    }
  }

  return async function radar({ force = false } = {}) {
    const tasks = [
      ...feeds.map((source) => load(source, "news", (client) => readFeed(client, source), force)),
      load(communitySource, "community", readCommunity, force),
      load(toolSource, "tools", readTools, force),
    ];
    const results = await Promise.all(tasks);
    const byFeed = results.slice(0, feeds.length).map((result) => result.items);
    const allNews = byFeed.flat()
      .filter((item, index, items) => items.findIndex((other) => other.url === item.url || other.title === item.title) === index)
      .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
    const balanced = byFeed.flatMap((items) => items.slice(0, 2));
    const news = [...balanced, ...allNews]
      .filter((item, index, items) => items.findIndex((other) => other.url === item.url || other.title === item.title) === index)
      .slice(0, 12)
      .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
    const sources = results.map((result) => result.source);
    return {
      updatedAt: new Date(now()).toISOString(),
      news,
      discussions: results[feeds.length].items,
      tools: results[feeds.length + 1].items,
      sources,
      partial: sources.some((source) => !source.ok),
    };
  };
}
