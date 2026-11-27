const byId = (id) => document.getElementById(id);
const message = (text) => { byId("feedback").textContent = text; };
const labels = { owner: "所有者", editor: "编辑者", viewer: "查看者" };
let workspaces = [];
let activeProject;
let activeJob;
let activeRequest;
let articleSource;
let editedMonitor;
let lastJobs = [];
let refreshTimer;
const jobStates = {
  queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败",
  partial: "部分完成", review: "待核对", canceled: "已取消",
};

async function api(path, method = "GET", body, requestKey) {
  const response = await fetch(path, {
    method,
    ...(body && { headers: {
      "Content-Type": "application/json",
      ...(requestKey && { "Idempotency-Key": requestKey }),
    }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = new Error((await response.json()).error);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const selected = () => workspaces.find(({ id }) => id === byId("spaces").value);
const base = () => "/api/workspaces/" + selected()?.id;

function item(label, buttonLabel, action) {
  const li = document.createElement("li");
  li.textContent = label;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = buttonLabel;
    button.addEventListener("click", () => { void action().catch((error) => message(error.message)); });
    li.append(button);
  }
  return li;
}

async function refresh() {
  byId("project").hidden = true;
  activeProject = activeJob = articleSource = editedMonitor = undefined;
  clearTimeout(refreshTimer);
  const space = selected();
  const workspace = base();
  byId("invite-link").textContent = "";
  byId("projects").replaceChildren();
  byId("members").replaceChildren();
  byId("new-project").hidden = space?.role === "viewer" || !space;
  byId("team").hidden = space?.role !== "owner";
  if (!space) return;
  const projects = await api(workspace + "/projects");
  if (selected()?.id !== space.id) return;
  byId("projects").replaceChildren(...projects.map((project) =>
    item(project.name, "打开项目", () => openProject(project)),
  ));
  if (space.role !== "owner") return;
  const members = await api(workspace + "/members");
  if (selected()?.id !== space.id) return;
  byId("members").replaceChildren(...members.map(({ id, email, role }) =>
    item(email + " · " + labels[role], "移除", async () => {
      await api(workspace + "/members/" + id, "DELETE");
      await refresh();
    }),
  ));
}

function projectPath() {
  return base() + "/projects/" + activeProject.id;
}

async function openProject(project) {
  const workspace = selected();
  activeProject = project;
  activeJob = undefined;
  byId("start-seo").reset();
  byId("monitor-feedback").textContent = "";
  byId("project").hidden = false;
  byId("project-title").textContent = project.name;
  byId("job-details").hidden = true;
  byId("new-geo").hidden = workspace.role === "viewer";
  articleSource = editedMonitor = undefined;
  byId("monitor-form").reset();
  byId("article-source-status").textContent = "";
  byId("article-optimization").reset();
  const path = projectPath();
  const [platforms, features] = await Promise.all([api(path + "/platforms"), api(path + "/features")]);
  if (activeProject !== project) return;
  byId("article-tools").hidden = workspace.role === "viewer" || (!features.articleSource && !features.articleReports);
  byId("article-source").hidden = !features.articleSource;
  byId("article-optimization").hidden = !features.articleReports;
  const visionModels = platforms.filter(({ ready, vision }) => ready && vision);
  const models = byId("article-optimization").elements.platform;
  models.replaceChildren(...visionModels.map(({ id, label }) => new Option(label, id)));
  if (!visionModels.length) models.add(new Option("暂无已验证的识图模型", ""));
  byId("article-optimization").querySelector("button").disabled = !visionModels.length;
  const options = platforms.map(({ id, label, ready }) => {
    const option = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.name = "platforms";
    check.value = id;
    check.disabled = !ready;
    option.append(check, label + (ready ? "" : "（暂不可用）"));
    return option;
  });
  byId("geo-platforms").replaceChildren(...options);
  byId("site-tools").hidden = !features.seo;
  byId("site-challenge").hidden = workspace.role === "viewer";
  byId("seo-demo").hidden = workspace.role === "viewer";
  byId("monitor-form").hidden = workspace.role === "viewer";
  byId("save-seo-monitor").hidden = !features.seo;
  if (features.seo) await refreshSite();
  updateEstimate();
  await Promise.all([jobList(), listMonitors()]);
}

async function jobList() {
  if (!activeProject) return;
  const current = activeProject;
  const jobs = await api(projectPath() + "/jobs");
  if (activeProject !== current) return;
  lastJobs = jobs;
  byId("jobs").replaceChildren(...jobs.map((job) =>
    item((job.name || job.kind) + " · " + jobStates[job.status], "详情", () => showJob(job.id)),
  ));
}

async function showJob(id, baseline) {
  if (!activeProject) return;
  clearTimeout(refreshTimer);
  const current = activeProject;
  const path = projectPath();
  activeJob = id;
  const job = await api(path + "/jobs/" + id + (baseline ? "?baseline=" + encodeURIComponent(baseline) : ""));
  if (current !== activeProject || id !== activeJob) return;
  const detail = byId("job-details");
  detail.hidden = false;
  const header = document.createElement("h3");
  header.textContent = (job.input.name || "检测结果") + " · " + jobStates[job.status];
  const list = document.createElement("ul");
  for (const step of job.steps) {
    const row = document.createElement("li");
    const evidence = step.result;
    row.append((evidence?.model || step.channel || "任务") + " · " + (jobStates[step.state] || step.state));
    if (evidence?.answer) {
      const answer = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = [evidence.configuredModel, evidence.channelType, evidence.searchStatus].filter(Boolean).join(" · ");
      const body = document.createElement("p");
      body.textContent = evidence.answer;
      answer.append(summary, body);
      for (const source of evidence.sources || []) {
        let url;
        try { url = new URL(source.url); } catch { continue; }
        if (!["https:", "http:"].includes(url.protocol)) continue;
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = (source.type === "citation" ? "正式引用" : "正文链接") + " · " + url.href;
        answer.append(link, document.createElement("br"));
      }
      row.append(answer);
    } else if (evidence?.error) {
      row.append(" · " + evidence.error);
    } else if (step.error_category) {
      row.append(" · " + step.error_category);
    }
    if (job.kind === "article-source" && evidence?.text) {
      const preview = document.createElement("div");
      const text = document.createElement("p");
      text.textContent = evidence.text;
      preview.append(text);
      for (const image of evidence.images ?? []) {
        if (!["image/png", "image/jpeg"].includes(image.type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) continue;
        const thumbnail = document.createElement("img");
        thumbnail.alt = "文章配图 " + image.number;
        thumbnail.src = "data:" + image.type + ";base64," + image.base64;
        preview.append(thumbnail);
      }
      row.append(preview);
      if (selected().role !== "viewer") {
        articleSource = job.id;
        byId("article-optimization").elements.title.value = evidence.title;
        byId("article-optimization").elements.text.value = evidence.text;
        byId("article-source-status").textContent = [
          "已导入 " + (evidence.images?.length ?? 0) + " 张图",
          evidence.omittedImages ? "省略 " + evidence.omittedImages + " 张" : "",
          evidence.truncated ? "正文已截断" : "",
        ].filter(Boolean).join(" · ");
      }
    }
    if (evidence?.artifact) {
      const download = document.createElement("a");
      download.href = path + "/reports/" + encodeURIComponent(evidence.artifact);
      download.textContent = "下载报告";
      row.append(" ", download);
    }
    if (evidence?.reports) {
      for (const { id: artifactId, name } of evidence.reports) {
        const a = document.createElement("a");
        a.href = path + "/reports/" + encodeURIComponent(artifactId);
        a.textContent = name;
        row.append(" ", a);
      }
    }
    if (evidence?.markdown) {
      if (job.input.historical) {
        const link = document.createElement("a");
        link.href = path + "/jobs/" + job.id + "/markdown";
        link.textContent = "下载历史报告";
        row.append(" ", link);
      }
      const report = document.createElement("pre");
      report.textContent = evidence.markdown;
      row.append(report);
    }
    list.append(row);
  }
  detail.replaceChildren(header, list);
  renderMeasurement(detail, job, baseline);
  const stillRunning = ["queued", "running"].includes(job.status);
  if (selected().role !== "viewer") {
    const action = (title, run) => {
      const button = document.createElement("button");
      button.textContent = title;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await run(); }
        catch (error) { message(error.message); button.disabled = false; }
      });
      detail.append(button);
    };
    if (stillRunning) {
      action("取消任务", async () => { await api(path + "/jobs/" + id + "/cancel", "POST"); await showJob(id); });
    } else if (job.kind === "geo") {
      if (job.input.historical) {
        action("按当前配置复测", () => submitGeo({ baselineId: id, useCurrentConfiguration: true }));
      } else {
        action("同题复测", () => submitGeo({ baselineId: id }));
      }
      if (!job.input.historical && job.steps.some(({ state }) => state === "failed") &&
          job.steps.every(({ state }) => ["failed", "succeeded"].includes(state))) {
        action("只补跑失败样本", () => submitGeo({ baselineId: id, failedOnly: true }));
      }
    }
  }
  if (stillRunning) {
    refreshTimer = setTimeout(() => { void showJob(id).catch((error) => message(error.message)); }, 2500);
  } else {
    await jobList();
  }
}

function submitGeo(payload) {
  return submitJob({ kind: "geo", ...payload });
}

async function submitJob(payload) {
  const path = projectPath();
  const signature = path + JSON.stringify(payload);
  if (activeRequest?.signature !== signature) activeRequest = { signature, key: crypto.randomUUID() };
  const { key } = activeRequest;
  const job = await api(path + "/jobs", "POST", payload, key);
  if (activeRequest?.key === key) activeRequest = undefined;
  if (activeProject && projectPath() === path) await showJob(job.id);
}

function para(parent, text) {
  const p = document.createElement("p");
  p.textContent = text;
  parent.append(p);
}

function renderMeasurement(detail, job, baseline) {
  if (!["geo", "seo"].includes(job.kind) || ["queued", "running"].includes(job.status)) return;
  const options = lastJobs.filter((row) => row.kind === job.kind && row.id !== job.id && !["queued", "running"].includes(row.status));
  const compare = document.createElement("select");
  compare.setAttribute("aria-label", "选择对照报告");
  compare.add(new Option("对照历史记录", ""));
  for (const row of options) compare.add(new Option((row.name || row.kind) + " · " + new Date(row.created_at).toLocaleString("zh-CN"), row.id));
  compare.value = baseline ?? job.baseline_id ?? "";
  compare.addEventListener("change", () => { void showJob(job.id, compare.value).catch((error) => message(error.message)); });
  detail.append(compare);
  for (const row of job.measurement ?? []) {
    para(detail, row.id + " · 有效 " + row.valid + "/" + row.planned + " · 正式引用 " +
      row.nativeCitations.count + "/" + row.nativeCitations.eligible + " · 实际联网 " + row.confirmedSearch);
    for (const entity of row.entities) {
      para(detail, entity.name + " · 提及 " + entity.mention.count + "/" + entity.mention.eligible +
        " · 无法判定 " + entity.mention.excluded + " · 引用 " + entity.cited.count + "/" + entity.cited.eligible);
      for (const source of entity.sources.slice(0, 10)) {
        const a = document.createElement("a");
        const url = new URL(source.url);
        if (!["https:", "http:"].includes(url.protocol)) continue;
        a.href = url.href;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = url.href + " · " + source.evidence.length + " 条原始回答";
        detail.append(a, document.createElement("br"));
        const proof = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "查看原始回答";
        proof.append(summary);
        for (const { result } of job.steps) if (source.evidence.includes(result?.evidenceId)) para(proof, result.answer);
        detail.append(proof);
      }
    }
  }
  for (const change of job.comparison ?? []) {
    const reasons = { configuration_changed: "采样条件变化", insufficient_samples: "有效样本不足" };
    const changeText = change.status === "comparable" ? "正式引用变动 " + (100 * change.citationDifference).toFixed(1) + " 个百分点" : reasons[change.status];
    para(detail, change.id + " · " + changeText);
  }
  const latest = job.kind === "seo" && job.steps[0]?.result;
  if (!latest) return;
  para(detail, "已抓取 " + latest.visited + " 页 · robots.txt 跳过 " + latest.skippedByRobots + " 页");
  const issues = job.seoComparison ?? latest.findings;
  const filter = document.createElement("select");
  filter.setAttribute("aria-label", "筛选问题严重度");
  for (const severity of ["全部严重度", "严重", "中等", "提醒"]) filter.add(new Option(severity));
  const query = document.createElement("input");
  query.placeholder = "筛选 URL 或规则";
  const rows = document.createElement("ul");
  const states = { new: "新增", persistent: "持续", fixed: "已修复", unverified: "未验证" };
  const draw = () => {
    const selected = issues.filter((issue) =>
      (filter.selectedIndex === 0 || filter.value === issue.severity) &&
      (issue.url + " " + issue.rule).toLowerCase().includes(query.value.trim().toLowerCase()),
    );
    rows.replaceChildren(...selected.map((issue) => item(
      [issue.severity, states[issue.state], issue.rule, issue.url, issue.recommendation, JSON.stringify(issue.evidence)].filter(Boolean).join(" · "),
    )));
  };
  filter.addEventListener("change", draw);
  query.addEventListener("input", draw);
  draw();
  detail.append(filter, query, rows);
}

function geoTarget() {
  const data = new FormData(byId("new-geo"));
  return {
    kind: data.get("kind"), name: data.get("name"), url: data.get("url"), question: data.get("question"),
    platforms: data.getAll("platforms"), sampleCount: Number(data.get("sampleCount")), webSearch: data.has("webSearch"),
  };
}

function seoTarget() {
  const data = new FormData(byId("start-seo"));
  return { url: data.get("url"), path: data.get("path"), pages: Number(data.get("pages")),
    depth: Number(data.get("depth")), rate: Number(data.get("rate")) };
}

async function refreshSite() {
  const current = activeProject;
  const site = await api(projectPath() + "/site");
  if (activeProject !== current) return;
  const edit = selected().role !== "viewer";
  const verified = site.site_verified_at && Date.now() - Date.parse(site.site_verified_at) <= 30 * 86400000;
  byId("site-state").textContent = !site.site_host ? "请先验证域名。" : verified
    ? "已验证 " + site.site_host
    : "添加 DNS TXT 记录 _yaosight." + site.site_host + "，记录值 " + site.site_challenge;
  byId("site-verify").hidden = !edit || !site.site_host || verified;
  byId("start-seo").hidden = !edit || !verified;
  if (verified && !byId("start-seo").elements.url.value) byId("start-seo").elements.url.value = "https://" + site.site_host + "/";
}

async function listMonitors() {
  const current = activeProject;
  const path = projectPath();
  const monitors = await api(path + "/monitors");
  if (activeProject !== current) return;
  byId("monitors").replaceChildren(...monitors.map((monitor) =>
    item(monitor.name + " · " + (monitor.active ? "运行计划中" : "已暂停"), "查看计划", async () => {
      const detail = await api(path + "/monitors/" + monitor.id);
      if (activeProject !== current) return;
      const output = byId("monitor-feedback");
      output.textContent = monitor.name + " · 版本 " + detail.current_version + " · " + detail.time_zone;
      for (const period of detail.trend ?? []) {
        const plans = period.models.map((model) => {
          const difference = period.changes.find(({ id }) => id === model.id);
          const delta = difference?.status === "comparable" ? "，变动 " + (100 * difference.citationDifference).toFixed(1) + " 个百分点"
            : difference?.status === "configuration_changed" ? "，条件变化" : "";
          return model.id + " 有效 " + model.valid + "/" + model.planned + " · 引用 " +
            model.nativeCitations.count + "/" + model.nativeCitations.eligible + delta;
        });
        para(output, new Date(period.slot).toLocaleDateString("zh-CN") + " · 问题集 v" + period.questionSetVersion + " · " + plans.join(" / "));
      }
      for (const period of detail.periods) {
        const summary = new Date(period.slot).toLocaleString("zh-CN") + " · " + (period.job_id ? "已提交" : "未运行");
        if (!period.job_id) para(output, summary);
        else output.append(item(summary, "结果", () => showJob(period.job_id)));
      }
      if (selected().role === "viewer") return;
      editedMonitor = detail;
      const form = byId("monitor-form");
      for (const field of ["name", "cadence"]) form.elements[field].value = detail[field];
      form.elements.active.checked = detail.active;
      form.elements.coverage.value = (detail.configuration.minimumCoverage ?? 0.8) * 100;
      form.elements.questions.value = detail.configuration.questions?.join("\n") ?? "";
      form.elements.competitors.value = (detail.configuration.competitors ?? []).map((row) => [row.name, row.domains[0], row.aliases[0]].filter(Boolean).join(",")).join("\n");
      if (detail.kind === "geo") {
        const geo = byId("new-geo");
        for (const field of ["kind", "name", "url", "sampleCount"]) geo.elements[field].value = detail.configuration[field];
        geo.elements.webSearch.checked = detail.configuration.webSearch === true;
        for (const checkbox of geo.querySelectorAll('[name="platforms"]')) checkbox.checked = detail.configuration.platforms.includes(checkbox.value);
        updateEstimate();
      } else {
        const seo = byId("start-seo");
        for (const field of ["url", "path", "pages", "depth", "rate"]) {
          if (detail.configuration[field] !== undefined) seo.elements[field].value = detail.configuration[field];
        }
      }
      output.append(item("手动执行", "立即运行", async () => {
        const job = await api(path + "/monitors/" + monitor.id + "/run", "POST", {}, crypto.randomUUID());
        await showJob(job.id);
      }));
      output.append(item("计划开关", detail.active ? "暂停" : "启用", async () => {
        await api(path + "/monitors/" + monitor.id + "/pause", "POST", { active: !detail.active });
        editedMonitor = undefined;
        output.textContent = "";
        form.reset();
        await listMonitors();
      }));
      output.append(item("新建计划", "清除编辑", async () => { editedMonitor = undefined; output.textContent = ""; form.reset(); }));
    }),
  ));
}

async function saveMonitor(kind) {
  const form = byId("monitor-form");
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const competitors = data.get("competitors").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, domain, alias] = line.split(/[,，]/).map((part) => part.trim());
    return { name, domains: domain ? [domain] : [], aliases: alias ? [alias] : [] };
  });
  const configuration = kind === "geo" ? {
    ...geoTarget(), minimumCoverage: Number(data.get("coverage")) / 100,
    questions: data.get("questions").split("\n").map((line) => line.trim()).filter(Boolean), competitors,
  } : seoTarget();
  const path = projectPath();
  const existing = editedMonitor?.kind === kind ? editedMonitor : null;
  await api(path + "/monitors" + (existing ? "/" + existing.id : ""), existing ? "PATCH" : "POST", {
    kind, name: data.get("name"), cadence: data.get("cadence"), active: data.has("active"), configuration,
    timeZone: existing?.time_zone ?? "Asia/Shanghai",
  });
  if (activeProject && path === projectPath()) {
    editedMonitor = undefined;
    byId("monitor-feedback").textContent = "计划已保存。";
    form.reset();
    await listMonitors();
  }
}

byId("save-geo-monitor").addEventListener("click", () => { void saveMonitor("geo").catch((error) => message(error.message)); });
byId("save-seo-monitor").addEventListener("click", () => { void saveMonitor("seo").catch((error) => message(error.message)); });
byId("site-verify").addEventListener("click", async () => {
  try { await api(projectPath() + "/site/verify", "POST"); await refreshSite(); }
  catch (error) { message(error.message); }
});

function updateEstimate() {
  const form = byId("new-geo");
  const data = new FormData(form);
  const count = data.getAll("platforms").length;
  byId("geo-estimate").textContent = "预计 " + count * Number(data.get("sampleCount")) + " 次请求";
  form.querySelector("button").disabled = count === 0;
}

byId("refresh-jobs").addEventListener("click", () => { void jobList().catch((error) => message(error.message)); });
byId("new-geo").addEventListener("change", updateEstimate);
byId("new-geo").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await submitGeo({ target: geoTarget() });
  } catch (error) { message(error.message); }
  finally { updateEstimate(); }
});

function form(id, handler) {
  byId(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const element = event.currentTarget;
    try { await handler(Object.fromEntries(new FormData(element))); element.reset(); }
    catch (error) { message(error.message); }
  });
}
form("article-source", async ({ url }) => {
  articleSource = undefined;
  await submitJob({ kind: "article-source", target: { url } });
});
byId("article-optimization").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await submitJob({ kind: "article-optimization", target: { ...data, sourceId: articleSource } });
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
form("site-challenge", async ({ domain }) => { await api(projectPath() + "/site/challenge", "POST", { domain }); await refreshSite(); });
form("start-seo", async () => { await submitJob({ kind: "seo", target: seoTarget() }); });
byId("seo-demo").addEventListener("click", () => {
  void submitJob({ kind: "seo", target: { demo: true } }).catch((error) => message(error.message));
});
form("new-project", async (params) => { await api(base() + "/projects", "POST", params); await refresh(); });
form("invite", async (params) => {
  const workspace = base();
  const { link } = await api(workspace + "/invitations", "POST", params);
  if (workspace === base()) byId("invite-link").textContent = link;
});

byId("spaces").addEventListener("change", () => { void refresh().catch((error) => message(error.message)); });
try {
  const { email } = await api("/api/me");
  message(email);
  byId("logout").hidden = false;
  workspaces = await api("/api/workspaces");
  for (const workspace of workspaces) byId("spaces").add(new Option(workspace.name, workspace.id));
  byId("workspace").hidden = !workspaces.length;
  if (!workspaces.length) message("没有可访问的工作空间。");
  await refresh();
} catch (error) {
  if (error.status === 401) byId("login").hidden = false;
  else message(error.message);
}
