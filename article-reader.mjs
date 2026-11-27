import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { loadBuffer } from "./vendor/niubigeo/node_modules/cheerio/dist/esm/index.js";
import { createPublicWebFetcher, validatePublicWebUrl } from "./vendor/niubigeo/dist/src/utils/public-web-fetch.js";
import { isArticleImage } from "./article-optimization.mjs";
import { GeoError } from "./geo-checks.mjs";

const byteLimit = 2 * 1024 * 1024;
const textLimit = 12000;
const imageToken = /\uE000(\d+)\uE001/g;
const redirectStatuses = [301, 302, 303, 307, 308];

function fetchBytes(accept) {
  return (url, addresses, signal) => new Promise((resolve, reject) => {
    if (url.port) return reject(new Error("Unsupported URL port"));
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      signal,
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      headers: { Accept: accept, "Accept-Encoding": "identity" },
    }, (response) => {
      const status = response.statusCode || 502;
      const contentType = response.headers["content-type"] || "";
      if (redirectStatuses.includes(status) || status < 200 || status >= 300) {
        response.destroy();
        resolve({ status, contentType, location: response.headers.location });
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > byteLimit) response.destroy(new Error("Response is too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status, contentType, text: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const fetchPage = createPublicWebFetcher(undefined, fetchBytes("text/html,application/xhtml+xml"));
const fetchImage = createPublicWebFetcher(undefined, fetchBytes("image/png,image/jpeg"));

function imageSource(node, base) {
  for (const attribute of ["data-src", "data-original", "data-lazy-src", "src"]) {
    const raw = node.attr(attribute)?.trim();
    if (!raw) continue;
    try {
      const url = validatePublicWebUrl(new URL(raw, base).href);
      if (!url.port) return url.href;
    } catch {
      // Try the next source, such as a public lazy-loading URL.
    }
  }
}

function contentRoot($) {
  for (const [selector, isArticle] of [
    ['[itemprop="articleBody"], #js_content, #article_content, .article-body, .article-content, .post-content, .entry-content, .markdown-body', true],
    ["article", true], ["main, [role=main]", false], ["body", false],
  ]) {
    const roots = $(selector);
    let best;
    let length = 0;
    roots.each((_index, element) => {
      const node = $(element);
      const count = (isArticle ? node : node.find("p, pre, blockquote")).text().trim().length;
      if (count > length) {
        best = node;
        length = count;
      }
    });
    if (length >= 30) return best;
  }
}

export function extractArticlePage(page) {
  const charset = /charset\s*=\s*["']?([^"'\s;]+)/i.exec(page.contentType)?.[1];
  const $ = loadBuffer(page.text, { encoding: { defaultEncoding: "utf-8", transportLayerEncodingLabel: charset } });
  $("script, style, noscript, template, svg, nav, footer, aside, form, [hidden], [aria-hidden=true], [role=navigation]").remove();
  const root = contentRoot($);
  const title = ($('meta[property="og:title"]').attr("content") || root?.find("h1").first().text() ||
    $("h1").first().text() || $("title").first().text()).replace(/\s+/g, " ").trim().slice(0, 180);
  if (!root || !title || /^(just a moment|access denied|attention required|验证访问|安全验证|访问受限)/i.test(title)) return null;

  const sources = [];
  const visited = new Set();
  root.find("img").each((_index, element) => {
    const node = $(element);
    const source = imageSource(node, page.url);
    if (!source || visited.has(source)) return;
    visited.add(source);
    sources.push(source);
    const number = sources.length;
    if (number <= 4) node.replaceWith("\n\uE000" + number + "\uE001\n");
  });
  root.find("p, h1, h2, h3, h4, h5, h6, div, section, li, blockquote, pre, figcaption, br, tr").before("\n").after("\n");
  const text = root.text().split("\n").map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.replace(imageToken, "").trim().length < 30) return null;
  return { title, text, sources };
}

async function readImage(url, number) {
  try {
    const image = await fetchImage(url);
    const type = image?.contentType.split(";")[0].trim().toLowerCase();
    if (image && isArticleImage(image.text, type)) return { number, type, base64: image.text.toString("base64") };
  } catch {
    // A page can still be imported when a CDN rejects or cannot serve a picture.
  }
  return null;
}

export async function readArticle(value) {
  let url;
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error();
    url = validatePublicWebUrl(value.trim());
    if (url.port) throw new Error();
    url.hash = "";
  } catch {
    throw new GeoError(400, "请输入公开文章的 HTTP 或 HTTPS 链接。");
  }
  let page;
  try { page = await fetchPage(url.href); }
  catch { throw new GeoError(422, "读取网页失败。请确认链接可公开打开，或粘贴文章正文。"); }
  if (!page || !/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.contentType)) {
    throw new GeoError(422, "这个链接暂时无法读取为文章网页，可以粘贴正文继续分析。");
  }
  const article = extractArticlePage(page);
  if (!article) throw new GeoError(422, "找不到可用的正文，可以粘贴正文继续分析。");
  const images = (await Promise.all(article.sources.slice(0, 4).map((source, index) => {
    const position = article.text.indexOf("\uE000" + (index + 1) + "\uE001");
    return position >= 0 && position < textLimit ? readImage(source, index + 1) : null;
  }))).filter(Boolean);
  const loaded = new Set(images.map((image) => image.number));
  const text = article.text.replace(imageToken, (_token, raw) => loaded.has(Number(raw)) ? "[图" + raw + "]" : "")
    .replace(/\n{3,}/g, "\n\n").trim();
  return {
    url: page.url, title: article.title, text: text.slice(0, textLimit),
    images, omittedImages: article.sources.length - images.length, truncated: text.length > textLimit,
  };
}
