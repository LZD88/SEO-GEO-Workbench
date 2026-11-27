const url = "https://example.com/";
const missing = url + "missing";
const report = {
  crawler: { name: "YaoSight 示例", version: "2.5.1" },
  results: [{ url, status: "200" }, { url: missing, status: "404" }],
  tables: { "404": { rows: [{ url: missing, sourceUqId: url, statusCode: "404" }] } },
};

export function seoDemo() {
  return {
    report,
    config: { url, host: "example.com", path: "/", pages: 2, rate: 1, depth: 1, demo: true },
    html: "<!doctype html><meta charset=utf-8><title>SEO 演示报告</title><h1>SEO 演示报告</h1><p>示例页面包含一条内部坏链。</p>",
  };
}
