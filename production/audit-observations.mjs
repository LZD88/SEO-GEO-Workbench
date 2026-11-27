import { load } from "../vendor/niubigeo/node_modules/cheerio/dist/esm/index.js";
import { createPublicWebFetcher } from "../vendor/niubigeo/dist/src/utils/public-web-fetch.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const accepted = /^(?:text\/html|application\/xhtml\+xml|text\/plain|text\/xml|application\/xml)(?:\s*;|$)/i;
const maxBytes = 512 * 1024;

function inspect(scope) {
  return createPublicWebFetcher(undefined, (url, addresses, signal) => new Promise((resolve, reject) => {
    if (url.hostname !== scope.host || url.port ||
        !(url.pathname.startsWith(scope.path) || ["/robots.txt", "/sitemap.xml"].includes(url.pathname))) {
      return reject(new Error("URL outside authorized crawl scope"));
    }
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(url, { signal, agent: false, headers: { "Accept-Encoding": "identity", "User-Agent": "SiteOne-Crawler" },
      lookup: (_host, options, cb) => options.all
        ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family),
    }, (res) => {
      const result = { status: res.statusCode, contentType: res.headers["content-type"] ?? "", location: res.headers.location };
      if (result.status < 200 || result.status >= 300 || !accepted.test(result.contentType)) {
        res.destroy();
        return resolve(result);
      }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) res.destroy(new Error("Response too large"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ ...result, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  }));
}

export async function inspectAudit(report, scope) {
  const fetch = inspect(scope);
  const canonical = {};
  const eligible = new Set((report.tables?.seo?.rows ?? []).map((row) => row.urlPathAndQuery));
  // SiteOne 2.5.1 omits the actual canonical value from JSON. Inspect a bounded subset
  // of successful HTML pages and leave everything else explicitly unverified.
  const deadline = Date.now() + 20000;
  for (const row of report.results.slice(0, 10)) {
    const url = new URL(row.url);
    if (Date.now() >= deadline) break;
    if (String(row.status) !== "200" || url.hostname !== scope.host || !eligible.has(url.pathname + url.search)) continue;
    try {
      const page = await fetch(url.href);
      if (page?.text && page.url === url.href && /html/i.test(page.contentType)) {
        const $ = load(page.text);
        const href = $('link[rel~="canonical"]').first().attr("href");
        canonical[url.href] = href ? new URL(href, page.url).href : null;
      }
    } catch { /* Coverage stays unknown. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000 / scope.rate));
  }
  let sitemap;
  if (Date.now() < deadline) {
    try {
      const target = new URL("/sitemap.xml", scope.url);
      const source = await fetch(target.href);
      if (source?.text) {
        const $ = load(source.text, { xml: true });
        const entries = $("url > loc, sitemap > loc").toArray();
        sitemap = { verified: true, valid: entries.length > 0 && entries.every((item) =>
          new URL($(item).text().trim()).hostname === scope.host), url: target.href };
      }
    } catch { /* Coverage stays unknown. */ }
  }
  return { canonical, sitemap };
}
