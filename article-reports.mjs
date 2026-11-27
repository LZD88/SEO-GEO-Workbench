import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GeoError } from "./geo-checks.mjs";

const reportId = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/;
const validId = new RegExp("^" + reportId.source + "$");
export const articleReportPath = new RegExp("^/api/article-reports/(" + reportId.source + ")(/markdown)?$");
const reportDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short",
});

export function articleReportMarkdown(report) {
  const title = report.title.replace(/\s+/g, " ");
  const model = [report.platform, report.model].filter(Boolean).join(" · ");
  const stamp = reportDate.format(new Date(report.generatedAt));
  const source = report.checkId ? "\n\n来源 GEO 检测 " + report.checkId : "";
  return "# 文章优化报告\n\n" + title + "\n\n" + model + " · " + stamp + source + "\n\n" + report.markdown + "\n";
}

export function createArticleReports(dataDir) {
  const file = (id) => join(dataDir, id + ".json");

  async function save({ title, platform, model, generatedAt, checkId, markdown }) {
    const report = { id: randomUUID(), title, platform, model, generatedAt, checkId, markdown };
    await mkdir(dataDir, { recursive: true });
    const final = file(report.id);
    const staging = final + ".tmp";
    await writeFile(staging, JSON.stringify(report) + "\n", { flag: "wx" });
    await rename(staging, final);
    return report;
  }

  async function read(id) {
    if (!validId.test(id)) {
      throw new GeoError(400, "报告标识无效。");
    }
    try { return JSON.parse(await readFile(file(id), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw new GeoError(404, "优化报告不存在。");
      throw error;
    }
  }

  async function list() {
    let entries;
    try { entries = await readdir(dataDir); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const reports = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -5);
      if (!validId.test(id)) continue;
      const { markdown, ...summary } = await read(id);
      reports.push(summary);
    }
    return reports.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)).slice(0, 30);
  }

  return { save, read, list };
}
