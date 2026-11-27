import { initTheme } from "./theme.js";
import { setupOverview } from "./overview.js";

initTheme();
const overview = setupOverview(api);
const $ = (selector) => document.querySelector(selector);
const geoForm = $("#geo-form");
const geoMessage = $("#geo-message");
const geoSubmit = geoForm.querySelector("[type=submit]");
const platformList = $("#platforms");
const platformHint = $("#platform-hint");
const question = $("#geo-question");
const crawlForm = $("#crawl-form");
const crawlStatus = $("#crawl-status");
const crawlSubmit = crawlForm.querySelector("[type=submit]");
const demoButton = $("#demo");
const resultBox = $("#geo-result");
const reportList = $("#reports");
const geoHistory = $("#geo-history");
const labels = { running: "抓取中", done: "报告已生成", error: "运行失败" };
const geoLabels = { running: "检测中", completed: "已完成", failed: "检测失败", interrupted: "检测中断", legacy: "历史记录" };
const drafts = { article: {}, brand: {} };
const fieldNames = ["name", "url", "question"];
let view;
let mode;
let lastJobId;
let submitting = false;
let active = false;
let renderedReports;
let historyLoad = 0;
let resultLoad = 0;
let selectedCheck;
let selectedState;
let geoSubmitting = false;
let platformsReady = false;
let renderedPlatforms;

async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) location.replace("/login");
  if (!response.headers.get("Content-Type")?.includes("application/json")) {
    throw new Error("工作台暂时不可用，请稍后重试。");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}

function message(target, text, error = false) {
  if (target.textContent !== text) target.textContent = text;
  target.classList.toggle("error", error);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(text, href) {
  const node = element("a", text, "text-link");
  node.href = href;
  return node;
}

function dates(timestamp) {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function setCurrent(selector, enabled) {
  if (enabled) $(selector).setAttribute("aria-current", "page");
  else $(selector).removeAttribute("aria-current");
}

function updateMode(next) {
  if (mode === next) return;
  if (mode) drafts[mode] = Object.fromEntries(fieldNames.map((name) => [name, geoForm.elements[name].value]));
  mode = next;
  const article = mode === "article";
  for (const name of fieldNames) geoForm.elements[name].value = drafts[mode][name] || "";
  $("#geo-form-title").textContent = article ? "新建文章检测" : "新建品牌检测";
  $("#geo-name-label").textContent = article ? "文章标题" : "品牌名称";
  $("#geo-name").placeholder = article ? "输入文章标题" : "输入要监测的品牌名称";
  $("#geo-name").maxLength = article ? 180 : 120;
  $("#geo-url-label").textContent = article ? "文章链接" : "品牌官网";
  $("#geo-url").placeholder = article ? "https://example.com/article" : "https://example.com/";
  $("#question-optional").hidden = !article;
  question.required = !article;
  $("#question-hint").textContent = article
    ? "留空时用文章标题生成问题。原文链接仅用于比对引用。"
    : "使用客户实际会问的问题。想了解自然推荐情况时，问题里可以省略品牌名。";
  $("#step-one-title").textContent = article ? "填写文章" : "填写品牌";
  $("#step-one-copy").textContent = article ? "填写文章标题与原文链接。" : "填写品牌名称、官网与客户问题。";
  $("#step-three-copy").textContent = article ? "核对模型提供的引用是否指向原文。" : "查看哪些模型回答提到了你的品牌。";
  message(geoMessage, "");
}

function route() {
  const next = location.hash.slice(1);
  view = ["article", "brand", "seo", "history"].includes(next) ? next : "overview";
  const isGeo = view === "article" || view === "brand";
  $("#geo-view").hidden = !isGeo;
  $("#overview-view").hidden = view !== "overview";
  $("#seo-view").hidden = view !== "seo";
  $("#history-view").hidden = view !== "history";
  $("#breadcrumb").textContent = isGeo ? "GEO 工具" : view === "seo" ? "SEO 数据" : view === "history" ? "历史记录" : "仪表盘";
  setCurrent("#overview-nav", view === "overview");
  setCurrent("#geo-nav", isGeo);
  setCurrent("#seo-nav", view === "seo");
  setCurrent("#history-nav", view === "history");
  setCurrent("#article-tab", view === "article");
  setCurrent("#brand-tab", view === "brand");
  if (isGeo) updateMode(view);
  if (view === "overview") void overview.refresh(true);
  if (view === "history") {
    void loadHistory();
    if (selectedCheck) void showResult(selectedCheck, true);
  }
  window.scrollTo(0, 0);
}

function syncGeoSubmit() {
  geoSubmit.disabled = !platformsReady || geoSubmitting;
}

function drawPlatforms(platforms) {
  const stamp = JSON.stringify(platforms);
  if (stamp !== renderedPlatforms) {
    const checked = new Set(new FormData(geoForm).getAll("platforms"));
    platformList.replaceChildren(...platforms.map(({ id, label, ready, search }) => {
      const card = element("label", "", "platform");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "platforms";
      input.value = id;
      input.disabled = !ready;
      input.checked = ready && checked.has(id);
      const icon = document.createElement("img");
      const extension = id === "gpt" || id === "gemini" ? ".svg" : ".png";
      icon.src = "/platform-icons/" + id + extension;
      icon.alt = "";
      card.append(input, icon, element("span", label));
      if (!ready || search) card.append(element("small", ready ? "联网" : "暂不可用"));
      return card;
    }));
    renderedPlatforms = stamp;
  }
  const available = platforms.filter((platform) => platform.ready).length;
  platformsReady = available > 0;
  syncGeoSubmit();
  platformHint.textContent = available
    ? "可多选。带「联网」标记的平台会尝试搜索。"
    : "当前没有可用平台，请联系管理员。";
  return available;
}

geoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (geoSubmit.disabled) return;
  const kind = mode;
  const data = new FormData(geoForm);
  const platforms = data.getAll("platforms");
  if (!platforms.length) {
    message(geoMessage, "请至少选择一个检测平台。", true);
    return;
  }
  const payload = { kind, name: data.get("name"), url: data.get("url"), question: data.get("question"), platforms };
  geoSubmitting = true;
  syncGeoSubmit();
  message(geoMessage, "正在提交检测…");
  try {
    const check = await api("/api/geo-checks", payload);
    selectedCheck = check;
    selectedState = check.state;
    message(geoMessage, "");
    if (view === "history") route();
    else location.hash = "history";
  } catch (error) {
    if (mode === kind) message(geoMessage, error.message, true);
  } finally {
    geoSubmitting = false;
    syncGeoSubmit();
  }
});

function empty(list, text) {
  list.replaceChildren(element("li", text, "empty"));
}

async function loadHistory() {
  const request = ++historyLoad;
  try {
    const items = await api("/api/geo-checks");
    if (request !== historyLoad) return;
    if (!items.length) return empty(geoHistory, "暂无 GEO 检测记录。");
    geoHistory.replaceChildren(...items.map((check) => {
      const row = document.createElement("li");
      const title = element("span", (check.kind === "article" ? "文章 · " : "品牌 · ") + check.name, "row-title");
      const actions = element("div", "", "row-actions");
      const result = element("button", "查看检测结果", "text-link");
      result.type = "button";
      result.addEventListener("click", () => void showResult(check));
      actions.append(result);
      row.append(title, element("span", [check.url, dates(check.createdAt), geoLabels[check.state]].filter(Boolean).join(" · "), "row-meta"),
        element("span", check.question, "row-meta"), actions);
      return row;
    }));
  } catch {
    if (request === historyLoad) empty(geoHistory, "暂时无法读取 GEO 检测记录。");
  }
}

function sampleDetail(sample, kind) {
  const row = document.createElement("li");
  let finding;
  if (sample.pending) finding = "检测中";
  else if (sample.error) finding = sample.error;
  else if (kind === "brand") finding = sample.mentioned ? "提及品牌" : "未提及品牌";
  else if (sample.cited) finding = "引用原文";
  else if (sample.textMatch) finding = "正文含原文链接";
  else finding = "未发现原文引用";
  const search = sample.usedSearch ? " · 已使用搜索" : "";
  row.append(element("span", sample.model + " · " + finding + search));
  if (sample.answer || sample.sources?.length) {
    const details = document.createElement("details");
    details.append(element("summary", "查看回答与来源"));
    if (sample.answer) details.append(element("p", sample.answer, "answer-text"));
    if (sample.sources?.length) {
      const sources = document.createElement("ul");
      for (const source of sample.sources) {
        const item = document.createElement("li");
        const url = link(source.url, source.url);
        url.target = "_blank";
        url.rel = "noopener noreferrer";
        item.append(document.createTextNode(source.type === "text" ? "正文链接 · " : "平台引用 · "), url);
        sources.append(item);
      }
      details.append(sources);
    }
    row.append(details);
  }
  return row;
}

async function showResult(check, updating = false) {
  const request = ++resultLoad;
  selectedCheck = check;
  const headline = element("h3", check.name);
  resultBox.hidden = false;
  if (!updating || !resultBox.children.length) resultBox.replaceChildren(headline, element("p", "正在读取结果…"));
  try {
    const { state, samples, measuredAt } = await api("/api/geo-checks/" + check.id);
    if (request !== resultLoad) return;
    const wasRunning = selectedState === "running";
    selectedState = state;
    if (wasRunning && state !== "running") void loadHistory();
    if (state === "pending" || state === "queued" || state === "interrupted") {
      const note = state === "interrupted" ? "这次检测已中断，请重新开始检测。" : "这条记录暂无检测结果。";
      resultBox.replaceChildren(headline, element("p", note));
      return;
    }
    const metric = check.kind === "article" ? "引用原文" : "提及品牌";
    const successful = samples.filter((sample) => !sample.pending && !sample.error);
    const hits = successful.filter((sample) => check.kind === "article" ? sample.cited : sample.mentioned);
    const details = element("p", state === "running"
      ? "检测中 · " + samples.filter((sample) => !sample.pending).length + " / " + samples.length + " 个平台已返回"
      : successful.length
      ? metric + " " + hits.length + " / " + successful.length + " 个成功样本"
      : "这次没有成功样本，请查看下方提示。");
    const rows = document.createElement("ul");
    rows.append(...samples.map((sample) => sampleDetail(sample, check.kind)));
    const note = measuredAt ? "最近一次 · " + dates(measuredAt) : "";
    resultBox.replaceChildren(headline, details, element("p", note, "hint"));
    if (rows.children.length) resultBox.append(rows);
  } catch (error) {
    if (request === resultLoad) resultBox.replaceChildren(headline, element("p", error.message, "error"));
  }
}

function setCrawlButtons() {
  demoButton.disabled = crawlSubmit.disabled = submitting || active;
}

function drawReports(jobs) {
  const snapshot = JSON.stringify(jobs);
  if (snapshot === renderedReports) return;
  renderedReports = snapshot;
  if (!jobs.length) return empty(reportList, "暂无 SEO 报告。");
  reportList.replaceChildren(...jobs.map((job) => {
    const row = document.createElement("li");
    const actions = element("div", "", "row-actions");
    for (const [type, text] of [["html", "HTML 报告"], ["json", "JSON 数据"], ["log", "运行日志"]]) {
      if (job.files.includes(type)) actions.append(link(text, "/api/reports/" + job.id + "/" + type));
    }
    row.append(element("span", job.demo ? "本地样例" : job.url, "row-title"),
      element("span", dates(job.createdAt) + " · " + labels[job.status], "row-meta"));
    if (actions.children.length) row.append(actions);
    if (job.error) row.append(element("p", job.error, "notice error"));
    return row;
  }));
}

async function refresh() {
  try {
    const { jobs, platforms } = await api("/api/status");
    active = jobs.some((job) => job.status === "running");
    setCrawlButtons();
    const available = drawPlatforms(platforms);
    overview.platforms(platforms);
    if (view === "overview") void overview.refresh();
    $("#geo-service").dataset.state = available ? "ready" : "offline";
    $("#service-text").textContent = available ? available + " 个 AI 平台可用" : "暂无可用 AI 平台";
    const selected = jobs.find((job) => job.id === lastJobId);
    if (selected) message(crawlStatus, selected.error || labels[selected.status], selected.status === "error");
    drawReports(jobs);
    if (view === "history" && selectedCheck && selectedState === "running") await showResult(selectedCheck, true);
  } catch {
    $("#geo-service").dataset.state = "offline";
    $("#service-text").textContent = "服务暂不可用";
    platformsReady = false;
    syncGeoSubmit();
    platformHint.textContent = "暂时无法读取平台状态，请刷新页面。";
  }
}

async function poll() {
  await refresh();
  setTimeout(poll, 2200);
}

async function startCrawl(payload) {
  if (submitting || active) return;
  submitting = true;
  setCrawlButtons();
  lastJobId = undefined;
  message(crawlStatus, "正在提交审计…");
  try {
    const { id } = await api("/api/crawls", payload);
    lastJobId = id;
    active = true;
    message(crawlStatus, "抓取中");
  } catch (error) {
    message(crawlStatus, error.message, true);
  } finally {
    submitting = false;
    setCrawlButtons();
  }
}

crawlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void startCrawl({ url: crawlForm.elements.url.value, authorized: crawlForm.elements.authorized.checked });
});
demoButton.addEventListener("click", () => void startCrawl({ demo: true }));
$("#logout").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api("/api/logout", {});
    location.replace("/home");
  } catch {
    button.textContent = "退出失败，重试";
    button.disabled = false;
  }
});
window.addEventListener("hashchange", route);
route();
void poll();

