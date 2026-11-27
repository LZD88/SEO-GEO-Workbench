import { initTheme } from "./theme.js";
import { setupOverview } from "./overview.js";
import { setupArticleAgent } from "./article-agent.js";
import { articleAdvice } from "./article-evidence.js";

initTheme();
const overview = setupOverview(api);
const articleAgent = setupArticleAgent(api);
const $ = (selector) => document.querySelector(selector);
const geoForm = $("#geo-form");
const geoMessage = $("#geo-message");
const geoSubmit = geoForm.querySelector("[type=submit]");
const platformList = $("#platforms");
const selectionCount = $("#selection-count");
const selectedPlatforms = $("#selected-platforms");

const platformHint = $("#platform-hint");
const question = $("#geo-question");
const crawlForm = $("#crawl-form");
const crawlStatus = $("#crawl-status");
const crawlSubmit = crawlForm.querySelector("[type=submit]");
const demoButton = $("#demo");
const resultBox = $("#geo-result");
const seoResultBox = $("#seo-result");
const reportList = $("#reports");
const geoHistory = $("#geo-history");
const geoRecent = $("#geo-recent");
const rechargeOptions = $(".recharge-options");
const rechargeCustom = $("#recharge-custom");
const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const pageTitles = {
  overview: "仪表盘", article: "GEO 工具", brand: "GEO 工具", optimize: "文章优化 Agent", seo: "SEO 审计",
  history: "历史记录", billing: "充值/订阅", recharge: "充值/订阅",
};
const labels = { running: "抓取中", done: "报告已生成", error: "运行失败" };
const geoLabels = { running: "检测中", completed: "已完成", failed: "检测失败", interrupted: "检测中断", legacy: "历史记录" };
const selectPlatformMessage = "请至少选择一个检测平台。";
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
let selectedCheckId;
let selectedSeoId;
let selectedState;
let choseDefaultPlatform = false;
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
  $("#workflow-first-title").textContent = article ? "填写文章" : "填写品牌";
  $("#workflow-first-copy").textContent = article
    ? "填入文章标题和原文链接，检测问题可以留空。"
    : "填入品牌名称、官网，以及客户会问的问题。";
  $("#guide-first-title").textContent = article ? "原文引用" : "品牌提及";
  $("#guide-first-copy").textContent = article ? "核对平台返回的引用是否指向原文。" : "检查各平台的回答里是否出现品牌名称。";
  $("#guide-second-title").textContent = article ? "正文链接" : "回答与来源";
  $("#guide-second-copy").textContent = article ? "单独标记回答正文里出现的原文链接。" : "查看每个平台的原始回答和附带的链接。";
  message(geoMessage, "");
}

function route() {
  const next = location.hash.slice(1);
  const checkLink = /^history\/([a-f0-9-]{36}|[a-f0-9]{64})$/.exec(next);
  const seoLink = /^history\/seo\/([a-f0-9-]{36})$/.exec(next);
  const reportLink = /^optimize\/([a-f0-9-]{36})$/.exec(next);
  view = checkLink || seoLink ? "history" : reportLink ? "optimize" : Object.hasOwn(pageTitles, next) ? next : "overview";
  selectedCheckId = checkLink?.[1];
  selectedSeoId = seoLink?.[1];
  selectedState = undefined;
  resultLoad++;
  resultBox.hidden = !selectedCheckId;
  seoResultBox.hidden = !selectedSeoId;
  const resultOpen = Boolean(selectedCheckId || selectedSeoId);
  $("#history-overview").hidden = resultOpen;
  $("#history-article").hidden = resultOpen;
  $("#history-back").hidden = !resultOpen;
  $("#history-title").textContent = selectedSeoId ? "网站检查报告" : selectedCheckId ? "AI 曝光结果" : "历史记录";
  $("#history-description").hidden = resultOpen;
  const isGeo = view === "article" || view === "brand";
  const isBilling = view === "billing" || view === "recharge";
  $("#geo-view").hidden = !isGeo;
  $("#overview-view").hidden = view !== "overview";
  $("#seo-view").hidden = view !== "seo";
  $("#optimize-view").hidden = view !== "optimize";
  $("#history-view").hidden = view !== "history";
  $("#billing-view").hidden = !isBilling;
  $("#subscription-panel").hidden = view !== "billing";
  $("#recharge-panel").hidden = view !== "recharge";
  $("#breadcrumb").textContent = pageTitles[view];
  setCurrent("#overview-nav", view === "overview");
  setCurrent("#geo-nav", isGeo);
  setCurrent("#seo-nav", view === "seo");
  setCurrent("#optimize-nav", view === "optimize");
  setCurrent("#history-nav", view === "history");
  setCurrent("#billing-nav", isBilling);
  setCurrent("#subscription-tab", view === "billing");
  setCurrent("#recharge-tab", view === "recharge");
  setCurrent("#article-tab", view === "article");
  setCurrent("#brand-tab", view === "brand");
  if (isGeo) updateMode(view);
  if (view === "overview") void overview.refresh(true);
  if (isGeo || view === "history") void loadHistory();
  if (selectedCheckId) void showResult(selectedCheckId);
  if (selectedSeoId) void showSeoResult(selectedSeoId);
  if (view === "optimize") void articleAgent.open(reportLink?.[1]);
  window.scrollTo(0, 0);
}

function updateRechargeTotal() {
  const preset = rechargeOptions.querySelector("input:checked");
  const amount = preset ? Number(preset.value) : rechargeCustom.valueAsNumber;
  $("#recharge-total").value = Number.isFinite(amount) && rechargeCustom.validity.valid ? currency.format(amount) : "—";
}

rechargeOptions.addEventListener("change", () => {
  rechargeCustom.value = "";
  updateRechargeTotal();
});
rechargeCustom.addEventListener("input", () => {
  const preset = rechargeOptions.querySelector("input:checked");
  if (preset) preset.checked = false;
  updateRechargeTotal();
});
updateRechargeTotal();

function syncGeoSubmit() {
  geoSubmit.disabled = !platformsReady || geoSubmitting;
}

function renderPlatformSelection() {
  const checked = [...platformList.querySelectorAll("input:checked:not(:disabled)")];
  const avatars = checked.map((input) => {
    const card = input.closest(".platform");
    const avatar = card.querySelector("img").cloneNode();
    avatar.alt = card.querySelector(".platform-name").textContent;
    avatar.title = avatar.alt;
    return avatar;
  });
  selectionCount.textContent = checked.length ? "已选 " + checked.length + " 个平台" : "未选择平台";
  selectedPlatforms.replaceChildren(...avatars);

  if (checked.length && geoMessage.textContent === selectPlatformMessage) message(geoMessage, "");
}

platformList.addEventListener("change", renderPlatformSelection);


function drawPlatforms(platforms) {
  const stamp = JSON.stringify(platforms.map(({ id, label, ready }) => [id, label, ready]));
  if (stamp !== renderedPlatforms) {
    const checked = new Set(new FormData(geoForm).getAll("platforms"));
    if (!choseDefaultPlatform) {
      const first = platforms.find(({ id, ready }) => ready && id === "gpt") || platforms.find(({ ready }) => ready);
      if (first) {
        checked.add(first.id);
        choseDefaultPlatform = true;
      }
    }
    platformList.replaceChildren(...platforms.map(({ id, label, ready }) => {
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
      const iconBox = element("span", "", "platform-icon");
      iconBox.append(icon);
      const caption = element("span", "");
      caption.append(element("span", label, "platform-name"),
        element("small", ready ? "可用" : "暂不可用"));
      card.append(iconBox, caption, input);
      return card;
    }));
    renderedPlatforms = stamp;
    renderPlatformSelection();
  }
  const available = platforms.filter((platform) => platform.ready).length;
  platformsReady = available > 0;
  syncGeoSubmit();
  platformHint.textContent = available
    ? "已为你选好一个可用平台，也可以多选。"
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
    message(geoMessage, selectPlatformMessage, true);
    return;
  }
  const payload = { kind, name: data.get("name"), url: data.get("url"), question: data.get("question"), platforms };
  geoSubmitting = true;
  syncGeoSubmit();
  message(geoMessage, "正在提交检测…");
  try {
    const check = await api("/api/geo-checks", payload);
    message(geoMessage, "");
    openGeoResult(check.id);
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

function openGeoResult(id) {
  const hash = "#history/" + id;
  if (location.hash === hash) resultBox.scrollIntoView({ block: "nearest" });
  else location.hash = hash;
}

function drawRecentChecks(items) {
  if (!items.length) {
    geoRecent.replaceChildren(element("li", "暂无 GEO 检测记录。", "dash-empty"));
    return;
  }
  geoRecent.replaceChildren(...items.slice(0, 3).map((check) => {
    const row = document.createElement("li");
    const button = element("button", "", "recent-button");
    button.type = "button";
    const caption = element("span", "", "dash-caption");
    caption.append(element("strong", check.name), element("small", check.kind === "article" ? "文章检测" : "品牌检测"));
    const status = element("span", geoLabels[check.state] || "已记录", check.state === "completed" ? "dash-status ready" : "dash-status");
    button.append(caption, status);
    button.addEventListener("click", () => openGeoResult(check.id));
    row.append(button);
    return row;
  }));
}

async function loadHistory() {
  const request = ++historyLoad;
  try {
    const items = await api("/api/geo-checks");
    if (request !== historyLoad) return;
    drawRecentChecks(items);
    if (!items.length) return empty(geoHistory, "暂无 GEO 检测记录。");
    geoHistory.replaceChildren(...items.map((check) => {
      const row = document.createElement("li");
      const summary = historySummary(check.name, check.kind === "article" ? "文章" : "品牌", check.createdAt,
        geoLabels[check.state] || "已记录", check.state === "completed" ? "ok" : check.state === "failed" ? "error" : "");
      row.append(summary, link(check.state === "running" ? "查看进度 →" : "查看结果 →", "#history/" + check.id));
      return row;
    }));
  } catch {
    if (request === historyLoad) {
      empty(geoHistory, "暂时无法读取 GEO 检测记录。");
      geoRecent.replaceChildren(element("li", "暂时无法读取检测记录。", "dash-empty"));
    }
  }
}

function historySummary(name, type, timestamp, label, tone) {
  const content = element("div", "", "history-record");
  const main = element("div", "", "history-record-main");
  main.append(element("span", name, "row-title"), element("span", type + " · " + dates(timestamp), "row-meta"));
  const badge = element("span", label, "history-status");
  if (tone) badge.dataset.tone = tone;
  content.append(main, badge);
  return content;
}

function groupSamples(samples) {
  return Object.values(Object.groupBy(samples, (sample) => sample.platformId || sample.model));
}

function platformOutcome(samples, kind) {
  const good = samples.filter((sample) => !sample.pending && !sample.error);
  if (!good.length) return samples.some((sample) => sample.pending) ? "等待结果" : "暂未返回结果";
  if (kind === "brand") return good.some((sample) => sample.mentioned) ? "提到了品牌" : "本次未提到品牌";
  if (good.some((sample) => sample.cited)) return "引用了文章";
  return good.some((sample) => sample.textMatch) ? "回答里有文章链接" : "本次未引用文章";
}

function platformEvidence(samples, kind) {
  const answers = samples.filter((sample) => sample.answer || sample.sources?.length);
  const outcome = platformOutcome(samples, kind);
  const panel = element(answers.length ? "details" : "div", "", "simple-evidence");
  const caption = element(answers.length ? "summary" : "p", "", "simple-evidence-title");
  caption.append(element("strong", samples[0].model), element("span", outcome, "hint"));
  panel.append(caption);
  for (const { answer, sources } of answers) {
    if (answer) panel.append(element("p", answer, "answer-text"));
    if (!sources?.length) continue;
    const list = element("ul", "", "plain-sources");
    for (const source of sources) {
      let url;
      try { url = new URL(source.url); } catch { continue; }
      if (!["https:", "http:"].includes(url.protocol)) continue;
      const item = element("li", "");
      const target = link(url.hostname, url.href);
      target.target = "_blank";
      target.rel = "noreferrer";
      item.append(document.createTextNode(source.type === "text" ? "回答中的链接 " : "引用来源 "), target);
      list.append(item);
    }
    if (list.children.length) panel.append(list);
  }
  return panel;
}

function geoOverview(check) {
  const groups = groupSamples(check.samples);
  const returned = groups.filter((group) => group.some((item) => !item.pending && !item.error)).length;
  const hits = groups.filter((group) => group.some((item) => !item.pending && !item.error &&
    (check.kind === "article" ? item.cited : item.mentioned))).length;
  if (check.state === "running") return "正在等 AI 回答，你可以稍后回来查看。";
  if (!returned) return "这次暂未拿到回答，可以稍后再试。";
  const result = !hits
    ? (check.kind === "article" ? "这次未发现正式引用。" : "这次未发现品牌提及。")
    : (check.kind === "article" ? hits + " 个平台引用了这篇文章。" : hits + " 个平台提到了这个品牌。");
  return result + " 共收到 " + returned + " 个平台的回答。";
}

function geoComparison(before, after) {
  const section = element("section", "", "geo-comparison");
  const comparisonNote = after.comparisonMode === "legacy" ? "旧结果的检测条件不完整，两次结果仅供参考。"
    : after.conditionsChanged ? "两次检测时的 AI 版本不同，结果仅供参考。"
    : "同一个问题的回答也可能变化，建议结合原回答看。";
  section.append(element("h4", "前后结果"), element("p", comparisonNote, "hint"));
  const sides = element("div", "", "geo-comparison-grid");
  for (const [label, run] of [["上次", before], ["这次", after]]) {
    const side = element("div", "", "geo-comparison-side");
    const heading = label === "上次" ? link(label + "结果 ↗", "#history/" + run.id) : element("strong", label + "结果");
    side.append(heading, element("p", geoOverview(run), "hint"));
    sides.append(side);
  }
  section.append(sides);
  return section;
}

function retestAction(check) {
  const controls = element("div", "", "geo-retest");
  const legacy = check.retestMode === "legacy";
  const button = element("button", "再测一次", "button quiet");
  const retry = check.canRetry ? element("button", "重试未返回的平台", "button quiet") : null;
  const status = element("p", legacy ? "这条旧记录将使用当前的检测方式。" : "", "hint");
  status.setAttribute("role", "status");
  async function submit(failedOnly) {
    button.disabled = true;
    if (retry) retry.disabled = true;
    message(status, failedOnly ? "正在提交补跑…" : "正在提交复测…");
    try {
      const next = await api("/api/geo-checks", { baselineId: check.id, useCurrentConfiguration: legacy, failedOnly });
      if (selectedCheckId === check.id) openGeoResult(next.id);
    } catch (error) {
      message(status, error.message, true);
    } finally {
      button.disabled = false;
      if (retry) retry.disabled = false;
    }
  }
  button.type = "button";
  button.addEventListener("click", () => void submit(false));
  controls.append(button);
  if (retry) {
    retry.type = "button";
    retry.addEventListener("click", () => void submit(true));
    controls.append(retry);
  }
  controls.append(status);
  return controls;
}

function renderGeoAdvice(kind, samples) {
  const successful = samples.filter((sample) => !sample.pending && !sample.error);
  const advice = kind === "article" ? articleAdvice(samples) : [];
  if (kind === "brand") {
    if (!successful.length) {
      advice.push(["稍后再试", "可以换一个 AI 平台，或等服务恢复后再检测。"]);
    } else if (successful.some((sample) => sample.mentioned)) {
      advice.push(["核对品牌被推荐的理由", "展开回答，检查品牌描述和适用场景是否准确。把需要澄清的事实补到官网，再用相同问题复测。"]);
    } else {
      advice.push(["围绕客户的选型问题补内容", "在官网用统一的品牌名说明适用人群、实际场景和案例。用不带品牌名的客户问题复测，观察自然提及。"]);
    }
    if (successful.length && samples.some((sample) => sample.error)) {
      advice.push(["重试未返回的平台", "点击下方的重试按钮，可以补齐没拿到的回答。"]);
    }
  }

  const section = element("section", "", "geo-advice");
  const title = element("h4", "接下来可以做什么");
  title.id = "geo-advice-title";
  section.setAttribute("aria-labelledby", title.id);
  const list = document.createElement("ol");
  for (const [heading, description] of advice) {
    const item = document.createElement("li");
    item.append(element("strong", heading), element("p", description));
    list.append(item);
  }
  section.append(title, list);
  return section;
}

async function showResult(id, updating = false) {
  const request = ++resultLoad;
  if (!updating) resultBox.replaceChildren(element("p", "正在读取结果…"));
  try {
    const check = await api("/api/geo-checks/" + id);
    const { state, samples, measuredAt } = check;
    if (request !== resultLoad) return;
    const headline = element("h3", check.name);
    const wasRunning = selectedState === "running";
    selectedState = state;
    if (wasRunning && state !== "running") void loadHistory();
    if (state === "pending" || state === "queued" || state === "interrupted") {
      const note = state === "interrupted" ? "这次检测已中断，请重新开始检测。" : "这条记录暂无检测结果。";
      resultBox.replaceChildren(headline, element("p", note));
      return;
    }
    const details = element("p", geoOverview(check), "history-takeaway");
    const note = measuredAt ? dates(measuredAt) : "";
    resultBox.replaceChildren(headline, details, element("p", note, "hint"));
    if (state !== "running") {
      const advice = renderGeoAdvice(check.kind, samples);
      if (check.kind === "article") {
        const action = element("button", "帮我优化这篇文章 →", "text-link advice-action");
        action.type = "button";
        action.addEventListener("click", () => articleAgent.attach(check));
        advice.append(action);
      }
      resultBox.append(advice);
    }
    resultBox.append(...groupSamples(samples).map((group) => platformEvidence(group, check.kind)));
    if (check.retestMode) resultBox.append(retestAction(check));
    if (check.baselineId && state !== "running") {
      let comparison;
      try { comparison = geoComparison(await api("/api/geo-checks/" + check.baselineId), check); }
      catch { comparison = element("p", "暂时无法读取复测基线。", "notice error"); }
      if (request === resultLoad) resultBox.append(comparison);
    }
  } catch (error) {
    if (request === resultLoad) resultBox.replaceChildren(element("p", error.message, "error"));
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
    const title = job.demo ? "网站检查样例" : new URL(job.url).hostname;
    row.append(historySummary(title, "网站检查", job.createdAt, labels[job.status] || "已记录",
      job.status === "done" ? "ok" : job.status === "error" ? "error" : ""));
    if (job.reportReady) row.append(link("查看报告 →", "#history/seo/" + job.id));
    if (job.status === "error") row.append(link("重新检查 →", "#seo"));
    return row;
  }));
}

async function showSeoResult(id) {
  seoResultBox.replaceChildren(element("p", "正在读取报告…"));
  try {
    const { demo, url, pages, findings, createdAt } = await api("/api/seo-reports/" + id);
    if (selectedSeoId !== id) return;
    const page = element("h3", demo ? "网站检查样例" : new URL(url).hostname);
    const summary = findings.length ? "建议先处理下面的问题。" : "这次检查没有发现需要列出的常见问题。";
    const subtitle = (pages === null ? "" : "检查了 " + pages + " 个网址。") + summary;
    seoResultBox.replaceChildren(page, element("p", subtitle, "history-takeaway"), element("p", dates(createdAt), "hint"));
    for (const finding of findings) {
      const section = element("section", "", "seo-finding");
      const badge = element("span", finding.priority === "repair" ? "优先处理" : "可以改进", "history-status");
      badge.dataset.tone = finding.priority === "repair" ? "error" : "ok";
      const caption = element("div", "", "simple-evidence-title");
      caption.append(element("h4", finding.title + "（" + finding.count + "）"), badge);
      section.append(caption, element("p", finding.next, "hint"));
      if (finding.examples.length) {
        const details = element("details", "", "seo-examples");
        const list = element("ul", "", "plain-sources");
        for (const example of finding.examples) {
          const row = element("li", [example.target, example.occurrences && "出现 " + example.occurrences + " 次",
            example.from && "来源 " + example.from, example.destination && "跳转到 " + example.destination].filter(Boolean).join(" · "));
          list.append(row);
        }
        details.append(element("summary", "查看涉及的页面"), list);
        section.append(details);
      }
      seoResultBox.append(section);
    }
    seoResultBox.append(link("再检查一个网站 →", "#seo"));
  } catch (error) {
    if (selectedSeoId === id) seoResultBox.replaceChildren(element("p", error.message, "error"));
  }
}

async function refresh() {
  try {
    const { jobs, platforms } = await api("/api/status");
    active = jobs.some((job) => job.status === "running");
    setCrawlButtons();
    const available = drawPlatforms(platforms);
    articleAgent.platforms(platforms);
    overview.platforms(platforms);
    if (view === "overview") void overview.refresh();
    $("#geo-service").dataset.state = available ? "ready" : "offline";
    $("#service-text").textContent = available ? "已配置 " + available + " 个 AI 平台" : "暂无可用 AI 平台";
    const selected = jobs.find((job) => job.id === lastJobId);
    if (selected) {
      if (selected.reportReady) {
        const href = "#history/seo/" + selected.id;
        if (!crawlStatus.querySelector("a")) crawlStatus.replaceChildren(link("检查完成，查看报告 →", href));
        crawlStatus.classList.remove("error");
      } else {
        message(crawlStatus, selected.status === "error" ? "这次检查未完成，请稍后重试。" : labels[selected.status], selected.status === "error");
      }
    }
    drawReports(jobs);
    if (selectedCheckId && selectedState === "running") await showResult(selectedCheckId, true);
  } catch {
    articleAgent.platforms([]);
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
    button.querySelector("span").textContent = "退出失败，重试";
    button.disabled = false;
  }
});
window.addEventListener("hashchange", route);
route();
void poll();

