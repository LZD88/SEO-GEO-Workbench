const rules = [
  ["404", "检查坏链", "这些链接指向打不开的页面。更新链接，或恢复应当保留的页面。", "repair"],
  ["redirects", "更新跳转链接", "将站内链接改为直接指向最终页面。", "improve"],
  ["non-unique-titles", "区分相同标题", "给不同页面写上各自的标题，方便访客找到需要的内容。", "improve"],
];

export function summarizeSeoReport(report) {
  const total = report.stats?.totalUrls;
  const pages = Number.isSafeInteger(total) && total >= 0 ? total : Array.isArray(report.results) ? report.results.length : null;
  const findings = [];
  for (const [key, title, next, priority] of rules) {
    const rows = report.tables?.[key]?.rows;
    if (!Array.isArray(rows) || !rows.length) continue;
    const examples = rows.slice(0, 5).map((row) => key === "non-unique-titles"
      ? { target: row.title, occurrences: Number(row.count) || undefined }
      : { target: row.url, from: row.sourceUqId, destination: row.targetUrl },
    );
    findings.push({ title, next, priority, count: rows.length, examples });
  }
  const metadata = report.tables?.seo?.rows;
  if (Array.isArray(metadata)) {
    const missing = metadata.filter((row) => typeof row.title === "string" && !row.title.trim() && row.robotsIndex !== "0");
    if (missing.length) findings.push({
      title: "补充页面标题", next: "给这些页面加一个能概括主要内容的标题。", priority: "improve",
      count: missing.length, examples: missing.slice(0, 5).map((row) => ({ target: row.urlPathAndQuery })),
    });
  }
  return { pages, findings };
}

export function publicGeoResult(check) {
  const { id, kind, name, url, question, createdAt, measuredAt, baselineId, comparisonMode, state, retestMode, canRetry, modelChanged } = check;
  return {
    id, kind, name, url, question, createdAt, measuredAt, baselineId, comparisonMode, state, retestMode, canRetry,
    conditionsChanged: modelChanged === true,
    samples: check.samples.map(({ model, platformId, error, pending, answer, sources, mentioned, cited, textMatch, evidence, usedSearch }) => ({
      model, platformId, pending, answer, sources, mentioned, cited, textMatch, evidence, usedSearch,
      error: error ? "这个平台暂时没有返回可用的回答。" : undefined,
    })),
  };
}
