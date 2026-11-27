import { articleAdvice } from "./article-evidence.js";

const byId = (id) => document.getElementById(id);
const reportDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short",
});

function renderMarkdown(markdown, container) {
  const nodes = [];
  let paragraph = [];
  let inCode = false;
  function addParagraph() {
    if (!paragraph.length) return;
    const body = document.createElement("p");
    body.textContent = paragraph.join("\n").trim();
    nodes.push(body);
    paragraph = [];
  }

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const heading = !inCode && /^#{1,4}\s+(.+)$/.exec(line);
    if (heading) {
      addParagraph();
      const title = document.createElement("h4");
      title.textContent = heading[1];
      nodes.push(title);
    } else if (!line.trim() && !inCode) {
      addParagraph();
    } else {
      paragraph.push(line);
    }
  }
  addParagraph();
  container.replaceChildren(...nodes);
}

function prepareImages(text) {
  const fieldset = byId("optimize-images");
  const input = byId("optimize-image-files");
  const list = byId("optimize-image-list");
  const status = byId("optimize-images-status");
  const images = new Map();
  let number = 0;

  function insert(markers) {
    const position = text.selectionEnd;
    if (text.value.length + markers.length > text.maxLength) {
      status.textContent = "正文已达字数上限，请留出空间再插入图号。";
      status.classList.add("error");
      return;
    }
    text.setRangeText(markers, position, position, "end");
    text.focus();
  }

  function add(files, importedNumbers = []) {
    const problems = new Set();
    const added = [];
    for (const [index, file] of Array.from(files).entries()) {
      if (images.size >= 4) {
        problems.add("最多添加 4 张图片。");
        break;
      }
      if (!["image/png", "image/jpeg"].includes(file.type) || !file.size || file.size > 2 * 1024 * 1024) {
        problems.add("请选择 PNG 或 JPG 图片，每张最多 2 MB。");
        continue;
      }

      const id = importedNumbers[index] ?? number + 1;
      number = Math.max(id, number);
      const url = URL.createObjectURL(file);
      const row = document.createElement("li");
      const preview = new Image();
      preview.alt = "图" + id;
      preview.src = url;
      const name = document.createElement("span");
      name.textContent = "图" + id + " · " + (file.name || "剪贴板图片");
      const put = document.createElement("button");
      const remove = document.createElement("button");
      put.type = remove.type = "button";
      put.textContent = "插入图号";
      remove.textContent = "移除";
      put.setAttribute("aria-label", "插入图" + id + "的编号");
      remove.setAttribute("aria-label", "移除图" + id);
      put.addEventListener("click", () => insert("[图" + id + "]"));
      remove.addEventListener("click", () => {
        images.delete(id);
        URL.revokeObjectURL(url);
        row.remove();
        status.textContent = text.value.includes("[图" + id + "]") ? "图" + id + "已移除，可以删除正文中的对应图号。" : "";
        status.classList.remove("error");
      });
      row.append(preview, name, put, remove);
      images.set(id, file);
      list.append(row);
      added.push(id);
    }
    status.textContent = [...problems].join(" ");
    status.classList.toggle("error", problems.size > 0);
    return added;
  }

  input.addEventListener("change", () => {
    add(input.files);
    input.value = "";
  });
  text.addEventListener("paste", (event) => {
    if (fieldset.disabled || !event.clipboardData) return;
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) {
      if (/<img\s/i.test(event.clipboardData.getData("text/html"))) {
        status.textContent = "复制内容含配图，请单独粘贴图片或上传图片文件。";
        status.classList.remove("error");
      }
      return;
    }
    const added = add(files);
    if (event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    if (added.length) insert(added.map((id) => "[图" + id + "]").join("\n"));
  });

  return {
    lock(disabled) { fieldset.disabled = disabled; },
    replace(imported) {
      const files = imported.map(({ type, base64, number }) => new File(
        [Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))],
        "网页图" + number + (type === "image/png" ? ".png" : ".jpg"),
        { type },
      ));
      for (const preview of list.querySelectorAll("img")) URL.revokeObjectURL(preview.src);
      images.clear();
      list.replaceChildren();
      number = 0;
      if (files.length) add(files, imported.map((item) => item.number));
      else {
        status.textContent = "";
        status.classList.remove("error");
      }
    },
    payload: () => Promise.all([...images].map(([number, file]) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ number, type: file.type, base64: reader.result.split(",")[1] });
      reader.onerror = () => reject(new Error("读取配图失败，请重新添加图片。"));
      reader.readAsDataURL(file);
    }))),
  };
}

export function setupArticleAgent(api) {
  const form = byId("optimize-form");
  const platform = form.elements.platform;
  const submit = byId("optimize-submit");
  const status = byId("optimize-status");
  const source = byId("optimize-url");
  const readButton = byId("optimize-read");
  const readStatus = byId("optimize-read-status");
  const context = byId("optimize-context");
  const checkPicker = byId("optimize-check");
  const checkStatus = byId("optimize-check-status");
  const download = byId("article-report-download");
  const history = byId("article-report-history");
  const reportStatus = byId("article-report-status");
  const reportSource = byId("article-report-source");
  let attachedCheck;
  let canUseEvidence = false;
  let checkLoad = 0;
  let articleLoad = 0;
  let lookupTimer;
  let choices;
  let requested = false;
  let reading = false;
  let reportLoad = 0;
  const images = prepareImages(form.elements.text);

  function sync() {
    const busy = requested || reading;
    const text = form.elements.text.value.trim();
    form.elements.text.required = !canUseEvidence;
    byId("optimize-text-hint").textContent = canUseEvidence
      ? "留空时只根据 GEO 结果生成建议。填写正文后，报告可以细化到段落。"
      : "填写 30–12,000 字符，建议保留原有的小标题和段落。";
    submit.disabled = busy || !platform.value || (text ? text.length < 30 : !canUseEvidence);
    submit.firstChild.textContent = canUseEvidence && !text ? "按 GEO 结果生成建议 " : "生成优化报告 ";
    checkPicker.disabled = busy;
    readButton.disabled = busy;
    source.readOnly = reading;
    form.elements.title.readOnly = reading;
    form.elements.text.readOnly = reading;
    byId("optimize-detach").disabled = busy;
    images.lock(busy);
  }

  async function listChecks() {
    const request = ++checkLoad;
    try {
      const checks = await api("/api/geo-checks?kind=article");
      if (request !== checkLoad) return;
      checkPicker.replaceChildren(new Option("直接填写或导入新文章", ""));
      for (const check of checks) checkPicker.add(new Option(check.name + " · " + reportDate.format(new Date(check.createdAt)), check.id));
      selectAttached();
    } catch {
      if (request === checkLoad && !attachedCheck) checkStatus.textContent = "暂时无法读取 GEO 记录，仍可以直接导入文章。";
    }
  }

  function selectAttached() {
    if (attachedCheck && ![...checkPicker.options].some((option) => option.value === attachedCheck.id)) {
      checkPicker.add(new Option(attachedCheck.name, attachedCheck.id));
    }
    checkPicker.value = attachedCheck?.id || "";
  }

  function applyArticle(article, saved) {
    images.replace(article.images);
    form.elements.title.value = article.title;
    form.elements.text.value = article.text;
    source.value = saved ? attachedCheck.url : article.url;
    readStatus.classList.remove("error");
    const notes = [saved ? "已自动带入这次检测的正文" : "已读取正文"];
    if (article.images.length) notes.push("和 " + article.images.length + " 张配图");
    if (article.omittedImages) notes.push("。部分配图未导入，可手动上传");
    if (article.truncated) notes.push("。正文已截取前 12,000 字符");
    readStatus.textContent = notes.join("") + "。";
  }

  async function loadContext(check, request) {
    try {
      const result = await api("/api/geo-checks/" + check.id + "/article");
      if (request !== articleLoad) return;
      canUseEvidence = result.canUseEvidence;
      if (result.status === "preparing") {
        checkStatus.textContent = "正在准备正文和配图，完成后会自动带入。";
        lookupTimer = setTimeout(() => void loadContext(check, request), 1200);
      } else if (result.article) {
        checkStatus.textContent = "已带入 GEO 结果。";
        if (!form.elements.text.value.trim() && source.value === check.url && !reading && !requested) {
          applyArticle(result.article, true);
        }
      } else {
        checkStatus.textContent = canUseEvidence
          ? "已有 GEO 结果，可以直接生成建议。需要逐段改写时，可以补充正文。"
          : "这条记录没有可用的文章或 AI 回答，可以读取文章或粘贴正文。";
      }
    } catch {
      if (request === articleLoad) checkStatus.textContent = "暂时无法载入这篇文章，请稍后重试。";
    } finally {
      if (request === articleLoad) sync();
    }
  }

  function attach(check) {
    if (requested || reading) return;
    if (attachedCheck?.id !== check.id) {
      clearTimeout(lookupTimer);
      const request = ++articleLoad;
      attachedCheck = check;
      canUseEvidence = false;
      images.replace([]);
      source.value = check.url || "";
      form.elements.title.value = check.name;
      form.elements.text.value = "";
      form.elements.question.value = check.question ?? "";
      byId("optimize-context-title").textContent = check.name;
      byId("optimize-previous-advice").textContent = "GEO 建议 · " + articleAdvice(check.samples)[0][0];
      context.hidden = false;
      checkStatus.textContent = "正在载入此文章的检测结果…";
      readStatus.textContent = "";
      readStatus.classList.remove("error");
      selectAttached();
      sync();
      void loadContext(check, request);
    }
    if (location.hash !== "#optimize") location.hash = "optimize";
  }

  function detach() {
    clearTimeout(lookupTimer);
    articleLoad++;
    attachedCheck = undefined;
    canUseEvidence = false;
    context.hidden = true;
    checkStatus.textContent = "";
    selectAttached();
    sync();
  }

  checkPicker.addEventListener("change", async () => {
    const id = checkPicker.value;
    if (!id) return detach();
    const request = ++articleLoad;
    try {
      const check = await api("/api/geo-checks/" + id);
      if (request === articleLoad) attach(check);
    } catch (error) {
      if (request === articleLoad) {
        selectAttached();
        if (attachedCheck) void loadContext(attachedCheck, request);
        else checkStatus.textContent = error.message;
      }
    }
  });
  byId("optimize-detach").addEventListener("click", detach);
  platform.addEventListener("change", sync);
  form.elements.text.addEventListener("input", sync);

  async function importArticle() {
    if (reading || requested) return;
    const url = source.value.trim();
    if (!url) {
      readStatus.textContent = "先填入要读取的文章链接。";
      readStatus.classList.add("error");
      source.focus();
      return;
    }
    reading = true;
    sync();
    readStatus.classList.remove("error");
    readStatus.textContent = "正在读取文章和配图…";
    try {
      const checkId = attachedCheck?.url === url ? attachedCheck.id : undefined;
      const article = await api("/api/article-source", { url, checkId });
      if (attachedCheck && !checkId) detach();
      applyArticle(article, Boolean(checkId));
    } catch (error) {
      readStatus.classList.add("error");
      readStatus.textContent = error.message || "暂时无法读取文章，请重试。";
    } finally {
      reading = false;
      sync();
    }
  }

  readButton.addEventListener("click", () => void importArticle());
  source.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void importArticle();
  });

  function platforms(available) {
    const ready = available.filter((item) => item.ready && item.vision);
    const stamp = JSON.stringify(ready.map(({ id, label }) => [id, label]));
    if (choices === stamp) return;
    choices = stamp;
    const chosen = ready.some(({ id }) => id === platform.value)
      ? platform.value : (ready.find(({ id }) => id === "gpt") || ready[0])?.id;
    platform.replaceChildren(...ready.map(({ id, label }) => new Option(label + "（支持图片）", id)));
    if (chosen) platform.value = chosen;
    else platform.add(new Option("暂无支持图片的模型", ""));
    platform.disabled = !chosen;
    sync();
  }

  function displayReport(report) {
    download.hidden = !report;
    byId("article-report-empty").hidden = Boolean(report);
    byId("article-report-result").hidden = !report;
    if (!report) return;
    byId("article-report-name").textContent = report.title;
    byId("article-report-meta").textContent = [report.platform, reportDate.format(new Date(report.generatedAt))]
      .filter(Boolean).join(" · ");
    reportSource.hidden = !report.checkId;
    if (report.checkId) reportSource.href = "#history/" + report.checkId;
    renderMarkdown(report.markdown, byId("article-report-content"));
    download.href = "/api/article-reports/" + report.id + "/markdown";
  }

  async function open(id) {
    if (!id) void listChecks();
    const request = ++reportLoad;
    history.disabled = true;
    reportStatus.classList.remove("error");
    reportStatus.textContent = id ? "正在读取报告…" : "";
    displayReport(null);
    const [listing, detail] = await Promise.allSettled([
      api("/api/article-reports"),
      id ? api("/api/article-reports/" + id) : Promise.resolve(null),
    ]);
    if (request !== reportLoad) return;
    const reports = listing.status === "fulfilled" ? listing.value : [];
    const report = detail.status === "fulfilled" ? detail.value : null;
    if (report && !reports.some((item) => item.id === id)) reports.push(report);
    history.replaceChildren(new Option(reports.length ? "选择历史报告" : "暂无已归档的报告", ""),
      ...reports.map((item) => new Option(item.title + " · " + reportDate.format(new Date(item.generatedAt)), item.id)));
    history.value = report?.id || "";
    history.disabled = !reports.length;
    const failed = detail.status === "rejected" ? detail : listing.status === "rejected" ? listing : null;
    reportStatus.classList.toggle("error", Boolean(failed));
    reportStatus.textContent = failed?.reason.message || "";
    displayReport(report);
  }

  history.addEventListener("change", () => {
    location.hash = history.value ? "optimize/" + history.value : "optimize";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    requested = true;
    sync();
    status.classList.remove("error");
    status.textContent = "正在分析文章并生成报告…";
    const payload = Object.fromEntries(new FormData(form));
    try {
      const evidenceOnly = canUseEvidence && !payload.text.trim();
      const report = await api("/api/article-optimization", {
        ...payload, checkId: attachedCheck?.id, evidenceOnly, images: evidenceOnly ? undefined : await images.payload(),
      });
      if (/^#optimize(?:\/|$)/.test(location.hash)) location.hash = "optimize/" + report.id;
      status.textContent = "报告已生成并归档。";
    } catch (error) {
      status.classList.add("error");
      status.textContent = error.message || "暂时无法生成报告，请重试。";
    } finally {
      requested = false;
      sync();
    }
  });

  return { attach, open, platforms };
}
