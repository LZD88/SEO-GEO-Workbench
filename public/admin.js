const byId = (id) => document.getElementById(id);
const views = {
  overview: ["运营概览", "查看业务记录、模型配置和用户端服务状态。"],
  geo: ["GEO 检测", "设置评测策略，查看回答、引用和每次运行的参数。"],
  seo: ["SEO 审计", "设置抓取范围，查阅审计记录、原始报告和日志。"],
  articles: ["文章优化", "查看文章优化报告、分析模型及关联的 GEO 检测。"],
  channels: ["模型渠道", "核对模型配置、渠道类型和最近成功调用。"],
  maintenance: ["系统维护", "临时暂停用户端服务，在这里发布公告或恢复服务。"],
};
const states = { completed: "已完成", running: "运行中", failed: "失败", done: "已完成", error: "失败", legacy: "历史记录", interrupted: "已中断" };
const finished = ["completed", "done"];
const warnings = ["failed", "error", "interrupted"];
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" });
const when = (date) => date && Number.isFinite(Date.parse(date)) ? dateFormat.format(new Date(date)) : "—";
let diagnosticRequest = 0;
let maintenance;
let pendingChange;
let updatingMaintenance = false;

function text(tag, value, className) {
  const item = document.createElement(tag);
  item.textContent = value;
  if (className) item.className = className;
  return item;
}

function show(message, error = false) {
  const notice = byId("console").hidden ? byId("login-message") : byId("message");
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

async function api(path, body) {
  const response = await fetch("/api/admin/" + path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败。");
  return payload;
}

function route() {
  const requested = location.hash.slice(1);
  const view = Object.hasOwn(views, requested) ? requested : "overview";
  const [title, description] = views[view];
  byId("crumb").textContent = title;
  byId("page-title").textContent = title;
  byId("page-description").textContent = description;
  for (const section of document.querySelectorAll("[data-view]")) section.hidden = section.id !== "view-" + view;
  for (const link of byId("admin-nav").querySelectorAll("a")) {
    if (link.hash === "#" + view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  show("");
}

function record(name, metadata, state) {
  const row = text("li", "");
  const head = text("div", "", "record-head");
  head.append(text("strong", name, "record-title"));
  if (state) {
    const badge = text("span", states[state] || "已记录", "tag");
    if (finished.includes(state)) badge.dataset.tone = "ok";
    if (warnings.includes(state)) badge.dataset.tone = "warning";
    head.append(badge);
  }
  row.append(head, text("p", metadata, "record-meta"));
  return row;
}

function renderList(id, records, draw, empty) {
  byId(id).replaceChildren(...(records.length ? records.map(draw) : [text("li", empty, "muted")]));
}

function link(label, href) {
  const item = text("a", label);
  item.href = href;
  return item;
}

function button(label, onClick) {
  const item = text("button", label);
  item.type = "button";
  item.addEventListener("click", onClick);
  return item;
}

function diagnostics(areaId, label, load, render) {
  const request = ++diagnosticRequest;
  const area = byId(areaId);
  area.hidden = false;
  area.textContent = label;
  void load().then((result) => {
    if (request !== diagnosticRequest) return;
    area.replaceChildren(...render(result));
    area.scrollIntoView({ block: "nearest" });
  }).catch((error) => {
    if (request === diagnosticRequest) area.textContent = error.message;
  });
}

function drawGeo(entry) {
  const row = record(entry.name, [when(entry.createdAt), entry.question].filter(Boolean).join(" · "), entry.state);
  const actions = text("div", "", "record-actions");
  actions.append(button("查看评测参数", () => diagnostics("diagnostic", "正在读取运行详情…", () => api("geo/" + entry.id), (check) => [
    text("h3", check.name), text("pre", JSON.stringify({
      评测问题: check.question, 目标: check.url, 提示词版本: check.promptVersion,
      平台设置: check.configuration, 采样次数: check.sampleCount, 对照记录: check.baselineId, 样本: check.samples,
    }, null, 2)),
  ])));
  row.append(actions);
  return row;
}

function drawSeo(entry) {
  const row = record(entry.demo ? "SEO 演示" : entry.url, when(entry.createdAt), entry.status);
  if (entry.error) row.append(text("p", entry.error, "record-meta"));
  if (entry.limits) {
    const details = text("details", "");
    details.append(text("summary", "本次抓取参数"), text("pre", JSON.stringify(entry.limits, null, 2)));
    row.append(details);
  }
  const actions = text("div", "", "record-actions");
  for (const [kind, label] of [["html", "HTML 原始报告"], ["json", "JSON 数据"], ["log", "运行日志"]]) {
    if (entry.files.includes(kind)) actions.append(link(label, "/api/admin/reports/" + entry.id + "/" + kind));
  }
  if (actions.children.length) row.append(actions);
  return row;
}

function drawArticle(entry) {
  const row = record(entry.title, [entry.platform, entry.model, when(entry.generatedAt)].filter(Boolean).join(" · "), "completed");
  const actions = text("div", "", "record-actions");
  const path = "articles/" + entry.id;
  actions.append(button("查看报告", () => diagnostics("article-detail", "正在读取优化报告…", () => api(path), (report) => {
    const content = [text("h3", report.title)];
    if (report.checkId) content.push(text("p", "关联 GEO 检测 · " + report.checkId, "record-meta"));
    content.push(text("pre", report.markdown));
    return content;
  })), link("下载 Markdown", "/api/admin/" + path + "/markdown"));
  row.append(actions);
  return row;
}

function drawMaintenance(state) {
  maintenance = state;
  const label = state.enabled ? "维护中" : "可用";
  const tone = state.enabled ? "warning" : "ok";
  for (const id of ["maintenance-state", "overview-service-state"]) {
    byId(id).textContent = label;
    byId(id).dataset.tone = tone;
  }
  byId("sidebar-status").textContent = "用户端" + label;
  byId("sidebar-status").parentElement.dataset.tone = tone;
  byId("nav-maintenance").hidden = !state.enabled;
  byId("overview-service-note").textContent = state.enabled ? state.message : "用户可以登录工作台并提交任务。";
  byId("announcement").value = state.message;
  byId("announcement").readOnly = state.enabled;
  const action = byId("maintenance-action");
  action.textContent = state.enabled ? "恢复用户服务" : "开启停服维护";
  action.className = state.enabled ? "primary" : "danger";
  byId("maintenance-updated").textContent = state.updatedAt ? "最近变更 · " + when(state.updatedAt) : "";
}

function draw(data) {
  const form = byId("settings");
  form.elements.sampleCount.value = data.settings.sampleCount;
  form.elements.webSearch.checked = data.settings.webSearch;
  const seoForm = byId("seo-settings");
  for (const [key, value] of Object.entries(data.seoLimits)) seoForm.elements[key].value = key === "timeout" ? value / 1000 : value;
  byId("geo-count").textContent = data.geo.length;
  byId("seo-count").textContent = data.seo.length;
  byId("article-count").textContent = data.articles.length;
  byId("channel-count").textContent = data.channels.filter((entry) => entry.ready).length;
  drawMaintenance(data.maintenance);
  byId("channels").replaceChildren(...data.channels.map((entry) => {
    const row = text("tr", "");
    const channel = entry.channelType === "relay-api" ? "中转 API" : "直连 API";
    row.append(...[entry.label, channel, entry.model || "—", entry.ready ? "已配置" : "未配置",
      [entry.search ? "联网" : "", entry.vision ? "识图（已配置）" : ""].filter(Boolean).join("、") || "对话",
      when(entry.lastSuccessAt)].map((value) => text("td", value)));
    return row;
  }));
  const recent = [
    ...data.geo.map(({ name, createdAt, state }) => ({ name, date: createdAt, state, type: "geo" })),
    ...data.seo.map(({ demo, url, createdAt, status }) => ({ name: demo ? "SEO 演示" : url, date: createdAt, state: status, type: "seo" })),
    ...data.articles.map(({ title, generatedAt }) => ({ name: title, date: generatedAt, state: "completed", type: "articles" })),
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 5);
  renderList("activity", recent, (entry) => {
    const row = record(entry.name, views[entry.type][0] + " · " + when(entry.date), entry.state);
    const actions = text("div", "", "record-actions");
    actions.append(link("进入管理 →", "#" + entry.type));
    row.append(actions);
    return row;
  }, "暂无业务记录。");
  renderList("geo", data.geo, drawGeo, "暂无 GEO 运行记录。");
  renderList("seo", data.seo, drawSeo, "暂无 SEO 审计记录。");
  renderList("articles", data.articles, drawArticle, "暂无文章优化报告。");
}

async function session() {
  const result = await api("session");
  byId("sign-in").hidden = result.signedIn;
  byId("console").hidden = !result.signedIn;
  byId("setup").hidden = result.configured;
  byId("login").hidden = !result.configured;
  if (result.signedIn) {
    route();
    draw(await api("overview"));
  }
}

function bind(formId, run) {
  byId(formId).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button");
    submit.disabled = true;
    try { await run(new FormData(form)); }
    catch (error) { show(error.message, true); }
    finally { submit.disabled = false; }
  });
}

bind("login", async (data) => {
  await api("login", { password: data.get("password") });
  byId("login").reset();
  show("");
  await session();
});
bind("settings", async (data) => {
  await api("settings", { sampleCount: Number(data.get("sampleCount")), webSearch: data.has("webSearch") });
  show("GEO 策略已保存。");
});
bind("seo-settings", async (data) => {
  const limits = Object.fromEntries([...data].map(([key, value]) => [key, Number(value)]));
  limits.timeout *= 1000;
  await api("seo-settings", limits);
  show("SEO 抓取策略已保存。");
});

const dialog = byId("maintenance-dialog");
const confirmButton = byId("maintenance-confirm");
byId("maintenance-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!maintenance || updatingMaintenance) return;
  pendingChange = { enabled: !maintenance.enabled, message: byId("announcement").value };
  const enabling = pendingChange.enabled;
  byId("confirm-title").textContent = enabling ? "开启停服维护？" : "恢复用户服务？";
  byId("confirm-copy").textContent = enabling ? "用户将看到维护公告。管理员后台可以继续使用。" : "用户将可以重新登录并提交任务。";
  confirmButton.textContent = enabling ? "确认停服" : "确认恢复";
  confirmButton.className = enabling ? "danger" : "primary";
  dialog.showModal();
});
dialog.addEventListener("cancel", (event) => { if (updatingMaintenance) event.preventDefault(); });
confirmButton.addEventListener("click", async () => {
  if (updatingMaintenance || !pendingChange) return;
  updatingMaintenance = true;
  confirmButton.disabled = byId("maintenance-cancel").disabled = true;
  try {
    const status = await api("maintenance", pendingChange);
    drawMaintenance(status);
    dialog.close();
    show(status.enabled ? "维护模式已开启。" : "用户服务已恢复。");
  } catch (error) {
    dialog.close();
    show(error.message, true);
  } finally {
    confirmButton.disabled = byId("maintenance-cancel").disabled = false;
    updatingMaintenance = false;
  }
});
byId("sign-out").addEventListener("click", async () => {
  try { await api("logout", {}); location.reload(); }
  catch (error) { show(error.message, true); }
});
byId("refresh").addEventListener("click", async (event) => {
  const refresh = event.currentTarget;
  refresh.disabled = true;
  try { draw(await api("overview")); show("数据已刷新。"); }
  catch (error) { show(error.message, true); }
  finally { refresh.disabled = false; }
});
window.addEventListener("hashchange", route);
void session().catch((error) => {
  if (byId("console").hidden) byId("sign-in").hidden = false;
  show(error.message, true);
});
