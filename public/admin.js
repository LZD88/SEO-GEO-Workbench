const byId = (id) => document.getElementById(id);
const notice = byId("message");
const states = { completed: "已完成", running: "运行中", failed: "失败", done: "已完成", error: "失败", legacy: "历史记录", interrupted: "已中断" };
let diagnosticsRequest = 0;

function text(tag, value, className) {
  const item = document.createElement(tag);
  item.textContent = value;
  if (className) item.className = className;
  return item;
}
function show(message, error = false) {
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
const when = (date) => date ? new Date(date).toLocaleString("zh-CN", { hour12: false }) : "—";
const state = (value) => states[value] || "已记录";

function item(name, metadata) {
  const row = text("li", "");
  row.append(text("strong", name, "record-title"), text("span", metadata, "record-meta"));
  return row;
}

async function inspect(id) {
  const request = ++diagnosticsRequest;
  const area = byId("diagnostic");
  area.hidden = false;
  area.textContent = "正在读取运行详情…";
  try {
    const check = await api("geo/" + id);
    if (request !== diagnosticsRequest) return;
    const summary = text("h3", check.name);
    const config = text("pre", JSON.stringify({
      评测问题: check.question, 目标: check.url, 提示词版本: check.promptVersion,
      平台设置: check.configuration, 采样次数: check.sampleCount, 对照记录: check.baselineId, 样本: check.samples,
    }, null, 2));
    area.replaceChildren(summary, config);
    area.scrollIntoView({ block: "nearest" });
  } catch (error) {
    if (request === diagnosticsRequest) area.textContent = error.message;
  }
}

function draw(data) {
  const form = byId("settings");
  form.elements.sampleCount.value = data.settings.sampleCount;
  form.elements.webSearch.checked = data.settings.webSearch;
  const limits = data.seoLimits;
  byId("seo-limits").replaceChildren(...[
    ["工作进程数", limits.workers], ["每秒请求", limits.rate], ["单次页面上限", limits.pages],
    ["待抓取队列上限", limits.queue], ["抓取深度", limits.depth], ["任务超时", limits.timeout / 1000 + " 秒"],
  ].flatMap(([label, value]) => [text("dt", label), text("dd", value)]));
  byId("channels").replaceChildren(...data.channels.map((entry) => {
    const row = text("tr", "");
    const channel = entry.channelType === "relay-api" ? "中转 API" : "直连 API";
    row.append(...[entry.label, channel, entry.model || "—", entry.ready ? "已配置" : "未配置",
      [entry.search ? "联网" : "", entry.vision ? "识图（已配置）" : ""].filter(Boolean).join("、") || "对话", when(entry.lastSuccessAt),
    ].map((value) => text("td", value)));
    return row;
  }));
  byId("geo").replaceChildren(...(data.geo.length ? data.geo.map((entry) => {
    const row = item(entry.name, [when(entry.createdAt), state(entry.state), entry.question].filter(Boolean).join(" · "));
    const action = text("button", "查看评测参数");
    action.type = "button";
    action.addEventListener("click", () => void inspect(entry.id));
    row.append(action);
    return row;
  }) : [text("li", "暂无 GEO 运行记录。")]));
  byId("seo").replaceChildren(...(data.seo.length ? data.seo.map((entry) => {
    const row = item(entry.demo ? "SEO 演示" : entry.url, when(entry.createdAt) + " · " + state(entry.status));
    if (entry.error) row.append(text("p", entry.error));
    if (entry.limits) {
      const details = text("details", "");
      details.append(text("summary", "本次抓取参数"), text("pre", JSON.stringify(entry.limits, null, 2)));
      row.append(details);
    }
    const actions = text("div", "", "record-actions");
    for (const [kind, label] of [["html", "HTML 原始报告"], ["json", "JSON 数据"], ["log", "运行日志"]]) {
      if (!entry.files.includes(kind)) continue;
      const a = text("a", label);
      a.href = "/api/admin/reports/" + entry.id + "/" + kind;
      actions.append(a);
    }
    if (actions.children.length) row.append(actions);
    return row;
  }) : [text("li", "暂无 SEO 运行记录。")]));
}

async function session() {
  const result = await api("session");
  byId("sign-in").hidden = result.signedIn;
  byId("sign-out").hidden = !result.signedIn;
  byId("console").hidden = !result.signedIn;
  byId("setup").hidden = result.configured;
  byId("login").hidden = !result.configured;
  if (result.signedIn) draw(await api("overview"));
}

function bind(formId, run) {
  byId(formId).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    try { await run(new FormData(form)); }
    catch (error) { show(error.message, true); }
    finally { button.disabled = false; }
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
  show("策略已保存。");
});
byId("sign-out").addEventListener("click", async () => {
  try { await api("logout", {}); location.reload(); }
  catch (error) { show(error.message, true); }
});
byId("refresh").addEventListener("click", async () => {
  try { draw(await api("overview")); show("运行记录已刷新。"); }
  catch (error) { show(error.message, true); }
});
void session().catch((error) => show(error.message, true));
