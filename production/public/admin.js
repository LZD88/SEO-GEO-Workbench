const get = (id) => document.getElementById(id);
const form = get("evaluation");
const jobs = get("jobs");
let screen = 0;
const selection = new URLSearchParams(location.search);

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function list(target, rows) {
  get(target).replaceChildren(...(rows.length ? rows : [text("li", "暂无记录。")]));
}

function notice(message, error = false) {
  get("message").textContent = message;
  get("message").classList.toggle("error", error);
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

function projectPath() {
  return "/api/workspaces/" + get("workspaces").value + "/projects/" + get("projects").value;
}

async function draw() {
  const index = ++screen;
  const current = get("projects").value;
  get("project-console").hidden = true;
  get("record").hidden = true;
  if (!current) return notice("当前工作空间没有站点项目。");
  const path = projectPath();
  const [{ settings, channels, reports, monitors }, history] = await Promise.all([api(path + "/evaluation"), api(path + "/jobs")]);
  if (index !== screen) return;
  notice("");
  get("project-console").hidden = false;
  for (const key of ["sampleCount", "minimumCoverage", "path", "pages", "depth", "rate"]) {
    form.elements[key].value = key === "minimumCoverage" ? 100 * settings[key] : settings[key];
  }
  form.elements.webSearch.checked = settings.webSearch;
  list("channels", channels.map(({ label, channelType, model, ready, search, vision }) =>
    text("li", [label, channelType === "relay-api" ? "中转 API" : "直连 API", model, ready ? "已配置" : "未配置",
      search && "支持联网", vision && "已配置识图"].filter(Boolean).join(" · "))));
  list("reports", reports.map(({ id, name }) => {
    const row = text("li", "");
    const link = text("a", name);
    link.href = path + "/reports/" + id;
    row.append(link);
    return row;
  }));
  list("monitors", monitors.map(({ name, version, configuration }) => {
    const row = text("li", "");
    const detail = text("details", "");
    detail.append(text("summary", name + " · v" + version), text("pre", JSON.stringify(configuration, null, 2)));
    row.append(detail);
    return row;
  }));
  list(jobs.id, history.filter(({ kind }) => ["geo", "seo"].includes(kind)).map(({ id, name, kind, status, created_at }) => {
    const row = text("li", (name || kind.toUpperCase()) + " · " + status + " · " + new Date(created_at).toLocaleString("zh-CN") + " ");
    const button = text("button", "查看评测记录");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        const record = await api(path + "/evaluation/" + id);
        if (index === screen) {
          get("record").textContent = JSON.stringify(record, null, 2);
          get("record").hidden = false;
          get("record").scrollIntoView({ block: "nearest" });
        }
      } catch (error) { notice(error.message, true); }
    });
    row.append(button);
    return row;
  }));
}

async function projects() {
  const workspaceId = get("workspaces").value;
  ++screen;
  get("project-console").hidden = true;
  if (!workspaceId) return notice("请先加入要维护的工作空间。");
  const entries = await api("/api/workspaces/" + workspaceId + "/projects");
  if (workspaceId !== get("workspaces").value) return;
  get("projects").replaceChildren(...entries.map(({ id, name }) => new Option(name, id)));
  const initial = selection.get("project");
  if (workspaceId === selection.get("workspace") && entries.some(({ id }) => id === initial)) get("projects").value = initial;
  await draw();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(form);
  const body = { webSearch: values.has("webSearch"), path: values.get("path") };
  for (const key of ["sampleCount", "minimumCoverage", "pages", "depth", "rate"]) body[key] = Number(values.get(key));
  body.minimumCoverage /= 100;
  const button = form.querySelector("button");
  const path = projectPath();
  button.disabled = true;
  try {
    await api(path + "/evaluation", body);
    if (path === projectPath()) notice("策略已保存。");
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});
get("workspaces").addEventListener("change", () => { void projects().catch((error) => notice(error.message, true)); });
get("projects").addEventListener("change", () => { void draw().catch((error) => notice(error.message, true)); });
try {
  const entries = await api("/api/workspaces");
  get("workspaces").replaceChildren(...entries.map(({ id, name }) => new Option(name, id)));
  const initial = selection.get("workspace");
  if (entries.some(({ id }) => id === initial)) get("workspaces").value = initial;
  await projects();
} catch (error) { notice(error.message, true); }
