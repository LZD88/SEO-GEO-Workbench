import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isPublicWebAddress } from "../vendor/niubigeo/dist/src/utils/public-web-fetch.js";
import { crawlerPath } from "./runtime.mjs";
import { normalizeAudit } from "./sites.mjs";
import { parseSeoReport } from "./seo-metrics.mjs";
import { inspectAudit } from "./audit-observations.mjs";
import { HttpError } from "./http.mjs";

const exec = promisify(execFile);
const fileLimit = 12 * 1024 * 1024;
const regexEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function runSiteOne(value) {
  const scope = normalizeAudit(value);
  const addresses = await lookup(scope.host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicWebAddress(address))) {
    throw new HttpError(422, "站点解析包含受限地址。");
  }
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  const directory = await mkdtemp(join(tmpdir(), "yaosight-siteone-"));
  try {
    const json = join(directory, "report.json");
    const html = join(directory, "report.html");
    const host = regexEscape(scope.host);
    const path = regexEscape(scope.path);
    const includes = "^https?://" + host + "(?::(?:80|443))?(?:" + path + "|/robots\\.txt$|/sitemap\\.xml$)";
    await exec(await crawlerPath(), [
      "--url=" + scope.url, "--workers=1", "--timeout=5",
      "--max-reqs-per-sec=" + scope.rate, "--max-visited-urls=" + scope.pages,
      "--max-depth=" + scope.depth, "--max-queue-length=" + scope.pages * 3,
      "--include-regex=" + includes, "--disable-all-assets", "--no-cache", "--memory-limit=256M",
      "--resolve=" + scope.host + ":80:" + selected.address,
      "--resolve=" + scope.host + ":443:" + selected.address,
      "--output-html-report=" + html, "--output-json-file=" + json, "--output-text-file=",
    ], {
      cwd: directory, timeout: 145000, maxBuffer: 512 * 1024, windowsHide: true,
      env: { HOME: directory, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    if ((await stat(json)).size > fileLimit || (await stat(html)).size > fileLimit) {
      throw new HttpError(422, "抓取报告超过大小上限。");
    }
    const [raw, document] = await Promise.all([readFile(json), readFile(html)]);
    const report = JSON.parse(raw);
    const parsed = parseSeoReport(report, scope, await inspectAudit(report, scope));
    return { parsed, raw: raw.toString("base64"), html: document.toString("base64") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
