import assert from "node:assert/strict";
import test from "node:test";
import { createAiRadar } from "../ai-radar.mjs";

const rss = (title, link, date = "Thu, 27 Nov 2026 08:00:00 GMT") => `
  <rss><channel><item><title>${title}</title><link>${link}</link>
  <pubDate>${date}</pubDate><description><![CDATA[<p>Useful &amp; current.</p>]]></description></item></channel></rss>`;

function response(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("AI radar merges live sources and keeps partial results when one source fails", async () => {
  const fetcher = async (url) => {
    if (url.includes("openai.com")) return response(rss("OpenAI update", "https://openai.com/update"));
    if (url.includes("deepmind.google")) throw new Error("timeout");
    if (url.includes("techcrunch.com")) return response(rss("AI launch", "https://techcrunch.com/launch"));
    if (url.includes("the-decoder.com")) return response(rss("Model news", "https://the-decoder.com/model"));
    if (url.includes("algolia.com")) return response({ hits: [{
      objectID: "7", title: "Show HN: an AI agent", url: "https://example.com/agent",
      created_at: "2026-11-27T07:00:00Z", points: 42, num_comments: 11,
    }] });
    if (url.includes("api.github.com")) return response({ items: [{
      id: 9, name: "toolbox", full_name: "sample/toolbox", html_url: "https://github.com/sample/toolbox",
      description: "AI utilities", stargazers_count: 321, language: "TypeScript", pushed_at: "2026-11-27T06:00:00Z",
    }] });
    throw new Error("unexpected URL");
  };
  const radar = createAiRadar({ fetcher, now: () => Date.parse("2026-11-27T09:00:00Z"), ttl: 0, refreshFloor: 0 });
  const result = await radar();

  assert.equal(result.news.length, 3);
  assert.equal(result.news[0].summary, "Useful & current.");
  assert.equal(result.discussions[0].comments, 11);
  assert.equal(result.tools[0].source, "sample/toolbox");
  assert.equal(result.partial, true);
  assert.deepEqual(result.sources.filter((source) => !source.ok).map((source) => source.label), ["Google DeepMind"]);
});

test("AI radar retains cached content when a later refresh fails", async () => {
  let failing = false;
  const fetcher = async (url) => {
    if (failing) throw new Error("offline");
    if (url.includes("algolia.com")) return response({ hits: [] });
    if (url.includes("api.github.com")) return response({ items: [] });
    return response(rss("Cached story", "https://example.com/cached"));
  };
  let clock = 100_000;
  const radar = createAiRadar({ fetcher, now: () => clock, ttl: 1, refreshFloor: 0 });
  const first = await radar();
  failing = true;
  clock += 10;
  const second = await radar({ force: true });

  assert.equal(first.news.length, 1);
  assert.equal(second.news.length, 1);
  assert.equal(second.news[0].title, "Cached story");
  assert.ok(second.sources.every((source) => source.stale || !source.ok));
});
