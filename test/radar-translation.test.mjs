import assert from "node:assert/strict";
import test from "node:test";
import { radarTextKey } from "../public/radar-language.js";
import { createRadarTranslation } from "../radar-translation.mjs";

const radar = {
  news: [{ title: "A new model", summary: "An open release.", url: "https://example.com/story" }],
  discussions: [{ title: "已经是中文的讨论" }],
  tools: [{ title: "tool-name", summary: "AI workflow manager" }],
};

test("Radar translation shares concurrent work, preserves source fields, and caches translated text", async () => {
  let calls = 0;
  const translate = createRadarTranslation({
    list: () => [{ id: "deepseek", ready: true }],
    async answer(id, prompt, options) {
      calls++;
      assert.equal(id, "deepseek");
      assert.equal(options.webSearch, false);
      const published = JSON.parse(prompt.split("\n").at(-1));
      assert.deepEqual(published, [
        { id: 0, title: "A new model", summary: "An open release." },
        { id: 1, summary: "AI workflow manager" },
      ]);
      return { text: JSON.stringify([
        { id: 0, title: "一款新模型", summary: "一项开放发布。", url: "https://example.org/" },
        { id: 1, summary: "AI 工作流管理工具", title: "忽略项目名称" },
      ]) };
    },
  });
  const [one, two] = await Promise.all([translate(radar), translate(radar)]);
  assert.deepEqual(one, two);
  assert.deepEqual(one, { translations: {
    [radarTextKey("A new model", "An open release.")]: { title: "一款新模型", summary: "一项开放发布。" },
    [radarTextKey("", "AI workflow manager")]: { summary: "AI 工作流管理工具" },
  }, partial: false });
  assert.deepEqual(await translate(radar), one);
  assert.equal(calls, 1);
});

test("Radar translation falls back after a provider error and reports missing translations", async () => {
  let time = 1000;
  const calls = [];
  const noTools = { ...radar, tools: [] };
  const translate = createRadarTranslation({
    list: () => [{ id: "deepseek", ready: true }, { id: "gpt", ready: true }],
    async answer(id) {
      calls.push(id);
      if (id === "deepseek") throw new Error("channel unavailable");
      return { text: time === 1000 ? '[{"id":0,"title":"缺少摘要"}]' : '[{"id":0,"title":"一款新模型","summary":"一项开放发布。"}]' };
    },
  }, { now: () => time });
  assert.deepEqual(await translate(noTools), { translations: {}, partial: true });
  assert.deepEqual(await translate(noTools), { translations: {}, partial: true });
  assert.deepEqual(calls, ["deepseek", "gpt"]);
  time += 31_000;
  assert.equal((await translate(noTools)).partial, false);
});
