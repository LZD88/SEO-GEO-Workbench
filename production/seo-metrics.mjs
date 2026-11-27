export const auditRuleVersion = 1;
const rules = {
  status: ["严重", "检查页面是否应恢复访问，或更新指向旧地址的链接。"],
  "broken-link": ["严重", "修复来源页面上的内部链接。"],
  redirect: ["中等", "将内部链接改为直接指向最终地址。"],
  noindex: ["中等", "确认页面是否应被索引，若需要收录请修正索引指令。"],
  canonical: ["中等", "检查页面的 canonical 是否指向首选版本。"],
  "robots-blocked": ["提醒", "确认 robots.txt 是否应允许采集此页面。"],
  sitemap: ["提醒", "检查 robots.txt 声明及 sitemap 中的站点地址。"],
  "title-missing": ["中等", "为页面添加独立并且准确的标题。"],
  "title-duplicate": ["中等", "用不同标题表达各页面的主要内容。"],
};

export function parseSeoReport(report, config, observations = {}) {
  if (typeof report.crawler?.version !== "string" || !/^2\.5\.1(?:\.|$)/.test(report.crawler.version) || !Array.isArray(report.results)) {
    throw new Error("SiteOne report version or structure is unsupported");
  }
  const results = new Map();
  const findings = new Map();
  const checked = new Map();
  const tables = report.tables ?? {};
  const urlOf = (value, base = config.url) => {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, base);
      if (url.hostname !== config.host || url.username || url.password || url.port ||
        !["http:", "https:"].includes(url.protocol) || !url.pathname.startsWith(config.path)) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  };
  function covered(rule, url) {
    if (!url) return;
    const urls = checked.get(rule) ?? new Set();
    urls.add(url);
    checked.set(rule, urls);
  }
  function issue(rule, url, evidence, qualifier = "") {
    if (!url) return;
    const key = JSON.stringify([rule, url, qualifier]);
    const [severity, recommendation] = rules[rule];
    findings.set(key, { key, rule, url, severity, evidence, recommendation, qualifier });
  }

  for (const row of report.results) {
    const url = urlOf(row.url);
    const status = Number(row.status);
    if (!url || !Number.isInteger(status) || status < 100 || status > 599) continue;
    results.set(url, status);
    covered("status", url);
    covered("redirect", url);
    covered("robots-blocked", url);
    if (status >= 400) issue("status", url, { status });
    if (status >= 300 && status < 400 && status !== 304) issue("redirect", url, { status });
  }
  for (const row of tables["404"]?.rows ?? []) {
    const target = urlOf(row.url);
    const from = urlOf(row.sourceUqId);
    if (from && target) issue("broken-link", from, { target, status: Number(row.statusCode) }, target);
  }
  for (const row of tables.redirects?.rows ?? []) {
    const url = urlOf(row.url);
    issue("redirect", url, { status: Number(row.statusCode), target: row.targetUrl });
  }
  const urlsByPath = new Map();
  for (const url of results.keys()) {
    const page = new URL(url);
    const key = page.pathname + page.search;
    urlsByPath.set(key, urlsByPath.has(key) ? null : url);
  }
  const titles = new Map();
  for (const row of tables.seo?.rows ?? []) {
    const url = urlsByPath.get(row.urlPathAndQuery) ?? null;
    if (!url || results.get(url) !== 200) continue;
    if (["0", "1"].includes(row.robotsIndex)) covered("noindex", url);
    if (row.robotsIndex === "0") issue("noindex", url, { directive: "noindex" });
    if (typeof row.title !== "string") continue;
    covered("title-missing", url);
    if (!row.title.trim()) issue("title-missing", url, { title: "" });
    else {
      const normalized = row.title.trim();
      const group = titles.get(normalized) ?? [];
      group.push(url);
      titles.set(normalized, group);
    }
  }
  for (const [title, urls] of titles) {
    if (urls.length > 1) for (const url of urls) issue("title-duplicate", url, { title, matchingPages: urls });
  }
  for (const row of tables.skipped?.rows ?? []) {
    if (/robots\.txt/i.test(row.reason)) {
      const url = urlOf(row.url);
      covered("robots-blocked", url);
      issue("robots-blocked", url, { reason: row.reason });
    }
  }
  for (const [url, value] of Object.entries(observations.canonical ?? {})) {
    if (results.get(url) !== 200) continue;
    covered("canonical", url);
    if (!value || value !== url) issue("canonical", url, { value: value || null });
  }
  if (observations.sitemap?.verified === true) {
    covered("sitemap", config.url);
    if (!observations.sitemap.valid) issue("sitemap", config.url, observations.sitemap);
  }
  return {
    ruleVersion: auditRuleVersion, config, visited: report.results.length,
    coverage: Object.fromEntries([...checked].map(([rule, urls]) => [rule, [...urls]])),
    skippedByRobots: [...findings.values()].filter((row) => row.rule === "robots-blocked").length,
    observedStatuses: Object.fromEntries(results),
    findings: [...findings.values()],
  };
}

export function seoComparison(previous, current) {
  const comparable = previous.ruleVersion === current.ruleVersion &&
    ["host", "path", "url"].every((key) => previous.config[key] === current.config[key]);
  const before = new Map(previous.findings.map((row) => [row.key, row]));
  const after = new Map(current.findings.map((row) => [row.key, row]));
  return [
    ...current.findings.map((row) => ({ ...row, state: comparable && before.has(row.key) ? "persistent" : "new" })),
    ...previous.findings.filter(({ key }) => !after.has(key)).map((row) => {
      let verified = comparable && current.coverage[row.rule]?.includes(row.url);
      if (row.rule === "broken-link") {
        const target = current.observedStatuses[row.qualifier];
        verified = comparable && current.observedStatuses[row.url] === 200 && target >= 200 && target < 300;
      }
      return { ...row, state: verified ? "fixed" : "unverified" };
    }),
  ];
}
