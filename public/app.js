import { initTheme } from "./theme.js";
import { setupOverview } from "./overview.js";
import { setupArticleAgent } from "./article-agent.js";

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
const geoSampleCount = $("#geo-sample-count");
const geoWebSearch = $("#geo-web-search");
const platformHint = $("#platform-hint");
const question = $("#geo-question");
const crawlForm = $("#crawl-form");
const crawlStatus = $("#crawl-status");
const crawlSubmit = crawlForm.querySelector("[type=submit]");
const demoButton = $("#demo");
const resultBox = $("#geo-result");
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
  const reportLink = /^optimize\/([a-f0-9-]{36})$/.exec(next);
  view = checkLink ? "history" : reportLink ? "optimize" : Object.hasOwn(pageTitles, next) ? next : "overview";
  selectedCheckId = checkLink?.[1];
  selectedState = undefined;
  resultLoad++;
  resultBox.hidden = !selectedCheckId;
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
  const searchable = checked.filter((input) => input.dataset.search === "true").length;
  geoWebSearch.disabled = !searchable;
  if (!searchable) geoWebSearch.checked = false;
  $("#geo-search-hint").textContent = searchable
    ? (searchable < checked.length ? "其他已选平台仍走普通对话。" : "启用后会请求平台执行搜索。")
    : "勾选支持联网的平台后可启用。";
  const count = Number(geoSampleCount.value);
  $("#geo-request-count").textContent = checked.length
    ? "预计发起 " + checked.length * count + " 次模型请求" + (geoWebSearch.checked ? "，其中 " + searchable * count + " 次请求联网。" : "。")
    : "";
  if (checked.length && geoMessage.textContent === selectPlatformMessage) message(geoMessage, "");
}

platformList.addEventListener("change", renderPlatformSelection);
geoSampleCount.addEventListener("change", renderPlatformSelection);
geoWebSearch.addEventListener("change", renderPlatformSelection);

function drawPlatforms(platforms) {
  const stamp = JSON.stringify(platforms.map(({ id, label, ready, search }) => [id, label, ready, search]));
  if (stamp !== renderedPlatforms) {
    const checked = new Set(new FormData(geoForm).getAll("platforms"));
    platformList.replaceChildren(...platforms.map(({ id, label, ready, search }) => {
      const card = element("label", "", "platform");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "platforms";
      input.value = id;
      input.dataset.search = String(search);
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
        element("small", !ready ? "未配置" : search ? "支持联网" : "普通对话"));
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
    ? "可多选。每个所选平台会收到同一个检测问题。"
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
  const payload = { kind, name: data.get("name"), url: data.get("url"), question: data.get("question"), platforms,
    sampleCount: Number(data.get("sampleCount")), webSearch: data.has("webSearch") };
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
      const title = element("span", (check.kind === "article" ? "文章 · " : "品牌 · ") + check.name, "row-title");
      const actions = element("div", "", "row-actions");
      const result = element("button", "查看检测结果", "text-link");
      result.type = "button";
      result.addEventListener("click", () => openGeoResult(check.id));
      actions.append(result);
      row.append(title, element("span", [check.url, dates(check.createdAt), geoLabels[check.state], check.baselineId && (check.comparisonMode === "retry" ? "补跑" : "复测")].filter(Boolean).join(" · "), "row-meta"),
        element("span", check.question, "row-meta"), actions);
      return row;
    }));
  } catch {
    if (request === historyLoad) {
      empty(geoHistory, "暂时无法读取 GEO 检测记录。");
      geoRecent.replaceChildren(element("li", "暂时无法读取检测记录。", "dash-empty"));
    }
  }
}

const evidenceLabels = {
  pending: "检测中", failed: "调用失败", mentioned: "提及品牌", citation: "平台引用原文", "text-link": "正文含原文链接",
};

function evidenceLabel(sample, kind) {
  return evidenceLabels[sample.evidence] || (kind === "brand" ? "未提及品牌" : "未发现原文链接");
}

function searchLabel(sample) {
  if (sample.usedSearch === true) return "实际已联网";
  if (sample.searchRequested === true) {
    return sample.pending || sample.error ? "请求联网 · 无执行结果" : "请求联网 · 未确认执行";
  }
  return sample.usedSearch === false ? "未使用联网" : "联网状态未知";
}

function sampleDetail(sample, kind) {
  const row = document.createElement("li");
  const badge = element("span", evidenceLabel(sample, kind), "evidence-badge");
  badge.dataset.evidence = sample.evidence || "miss";
  const model = sample.modelVersion ? "实际模型 " + sample.modelVersion : "实际模型未知";
  row.append(element("strong", "样本 " + (sample.number ?? 1)), badge, element("p",
    [searchLabel(sample), sample.configuredModel && "配置 " + sample.configuredModel, model,
      sample.retained && "沿用原结果", sample.measuredAt && dates(sample.measuredAt)].filter(Boolean).join(" · "), "hint"));
  if (sample.error) row.append(element("p", sample.error, "error"));
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

function evidenceSummary(samples, kind, showRatio = false) {
  const successful = samples.filter((sample) => !sample.pending && !sample.error);
  const ratio = (count) => showRatio ? (successful.length ? count + "/" + successful.length : "—") : String(count);
  const count = (evidence) => ratio(successful.filter((sample) => sample.evidence === evidence).length);
  return [
    showRatio ? "成功 " + successful.length + "/" + samples.length : successful.length + " / " + samples.length + " 个成功样本",
    ...(kind === "brand" ? ["品牌提及 " + count("mentioned")] : ["平台引用 " + count("citation"), "仅正文链接 " + count("text-link")]),
    "未命中 " + count("miss"),
    ...(showRatio ? ["实际联网 " + ratio(successful.filter((sample) => sample.usedSearch === true).length)] : []),
    "失败 " + samples.filter((sample) => sample.error).length,
  ].join(" · ");
}

function groupSamples(samples) {
  return Object.values(Object.groupBy(samples, (sample) => sample.platformId || sample.model));
}

function platformEvidence(samples, kind) {
  const group = element("section", "", "geo-platform-evidence");
  const rows = element("ul", "", "geo-samples");
  rows.append(...samples.map((sample) => sampleDetail(sample, kind)));
  group.append(element("h4", samples[0].model), element("p", evidenceSummary(samples, kind, true), "hint"), rows);
  return group;
}

function geoComparison(before, after) {
  const section = element("section", "", "geo-comparison");
  const retry = after.comparisonMode === "retry";
  const title = element("h4", retry ? "补跑对照" : "复测对照");
  const note = after.comparisonMode === "legacy"
    ? "基线缺少模型与联网配置快照。本次使用当前配置。"
    : retry ? "本次仅补跑失败样本，成功样本沿用原记录。"
    : "本次沿用了基线的问题、采样次数和请求配置。模型回答可能波动。";
  const sides = element("div", "", "geo-comparison-grid");
  for (const [label, run] of [["基线", before], ["本次", after]]) {
    const side = element("div", "", "geo-comparison-side");
    const heading = label === "基线" ? link(label + " ↗", "#history/" + run.id) : element("strong", label);
    const list = element("ul", "", "geo-comparison-samples");
    for (const samples of groupSamples(run.samples)) {
      list.append(element("li", samples[0].model + " · " + evidenceSummary(samples, run.kind, true)));
    }
    side.append(heading, element("p", dates(run.measuredAt || run.createdAt), "hint"),
      element("p", evidenceSummary(run.samples, run.kind), "hint"), list);
    sides.append(side);
  }
  section.append(title, element("p", note, "hint"), sides);
  const differs = after.samples.some((sample) => {
    const previous = before.samples.find((item) => item.platformId === sample.platformId && (item.number ?? 1) === (sample.number ?? 1));
    return previous?.modelVersion && sample.modelVersion && previous.modelVersion !== sample.modelVersion;
  });
  if (differs) section.append(element("p", "上游返回的实际模型版本有变化，比较时请考虑版本差异。", "notice"));
  return section;
}

function retestAction(check) {
  const controls = element("div", "", "geo-retest");
  const legacy = check.retestMode === "legacy";
  const button = element("button", legacy ? "按当前配置复测" : "同题复测", "button quiet");
  const failureCount = check.samples.filter((sample) => sample.error).length;
  const retry = check.canRetry ? element("button", "只补跑失败样本 (" + failureCount + ")", "button quiet") : null;
  const status = element("p", legacy ? "旧记录没有模型和联网配置快照，复测使用当前配置。"
    : "完整复测将发起 " + check.samples.length + " 次请求。", "hint");
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

function renderGeoAdvice(kind, successful, hits, hasFailures) {
  const advice = [];
  if (!successful.length) {
    advice.push(["先拿到可用样本", "查看上方的平台报错，换一个可用平台发起检测，或等出错的平台恢复后重试。拿到回答后再判断内容是否需要优化。"]);
  } else if (kind === "article") {
    if (hits.length) {
      advice.push(["保留已被引用的原文入口", "保留被引用的网址，及时更新对应段落。用相同的问题和平台复测，观察引用是否持续。"]);
    } else if (successful.some((sample) => sample.textMatch)) {
      advice.push(["核对平台的来源列表", "本次回答正文出现了原文链接。复测时保持问题一致，留意原文链接是否也出现在平台的来源列表里。"]);
    } else {
      advice.push(["让原文直接回答检测问题", "在文章开头给出一段可独立理解的答案，再用贴合问题的小标题组织步骤、示例和来源。发布后用相同问题复测。"]);
    }

    if (!successful.some((sample) => sample.usedSearch)) {
      advice.push(["补测联网引用", "本次成功样本均未记录联网搜索。用支持联网的平台补测，观察平台是否会主动找到并引用原文。"]);
    }
  } else if (hits.length) {
    advice.push(["核对品牌被推荐的理由", "展开回答，检查品牌描述和适用场景是否准确。把需要澄清的事实补到官网，并用相同问题复测。"]);
  } else {
    advice.push(["围绕客户的选型问题补内容", "在官网用统一的品牌名说明适用人群、实际场景和案例。用不带品牌名的客户问题复测，观察自然提及。"]);
  }

  if (successful.length && hasFailures) {
    advice.push(["补齐失败平台的样本", "等出错的平台恢复后单独补测，保持检测问题和目标一致，再比较各平台的结果。"]);
  }

  const section = element("section", "", "geo-advice");
  const title = element("h4", "GEO 优化建议");
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
    const successful = samples.filter((sample) => !sample.pending && !sample.error);
    const hits = successful.filter((sample) => check.kind === "article" ? sample.cited : sample.mentioned);
    const details = element("p", state === "running"
      ? "检测中 · " + samples.filter((sample) => !sample.pending).length + " / " + samples.length + " 个样本已返回"
      : evidenceSummary(samples, check.kind));
    const note = measuredAt ? "最近一次 · " + dates(measuredAt) : "";
    resultBox.replaceChildren(headline, details, element("p", note, "hint"));
    resultBox.append(...groupSamples(samples).map((group) => platformEvidence(group, check.kind)));
    if (check.retestMode) resultBox.append(retestAction(check));
    if (state !== "running") {
      const advice = renderGeoAdvice(check.kind, successful, hits, samples.some((sample) => sample.error));
      if (check.kind === "article") {
        const action = element("button", "带入文章优化 Agent →", "text-link advice-action");
        action.type = "button";
        action.addEventListener("click", () => articleAgent.attach(check));
        advice.append(action);
      }
      resultBox.append(advice);
    }
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
    articleAgent.platforms(platforms);
    overview.platforms(platforms);
    if (view === "overview") void overview.refresh();
    $("#geo-service").dataset.state = available ? "ready" : "offline";
    $("#service-text").textContent = available ? "已配置 " + available + " 个 AI 平台" : "暂无可用 AI 平台";
    const selected = jobs.find((job) => job.id === lastJobId);
    if (selected) message(crawlStatus, selected.error || labels[selected.status], selected.status === "error");
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

