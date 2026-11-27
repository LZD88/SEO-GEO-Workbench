import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readArticle } from "./article-reader.mjs";

export function createArticleContext(directory, reader = readArticle) {
  const pending = new Map();
  const file = (id) => {
    if (!/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(id)) throw new Error("Invalid article check ID");
    return join(directory, id + ".json");
  };

  async function stored(id) {
    try { return JSON.parse(await readFile(file(id), "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { status: "missing" };
    }
  }

  function load({ id, url }) {
    const active = pending.get(id);
    if (active) return active;
    const operation = (async () => {
      const existing = await stored(id);
      if (existing.status === "ready") return existing.article;
      let article;
      let failure;
      try { article = await reader(url); }
      catch (error) { failure = error; }
      const temp = file(id) + "." + randomUUID() + ".tmp";
      await mkdir(directory, { recursive: true });
      await writeFile(temp, JSON.stringify(article ? { status: "ready", article } : { status: "unavailable" }), { mode: 0o600 });
      await rename(temp, file(id));
      if (failure) throw failure;
      return article;
    })().finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
  }

  function prepare(check) {
    if (check.kind !== "article" || check.comparisonMode === "retry" || pending.size >= 2) return;
    void load(check).catch(() => {});
  }

  function find({ id }) {
    return pending.has(id) ? Promise.resolve({ status: "preparing" }) : stored(id);
  }

  return { prepare, find, load };
}
