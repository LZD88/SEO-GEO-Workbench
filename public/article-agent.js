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
  const download = byId("article-report-download");
  const history = byId("article-report-history");
  const reportStatus = byId("article-report-status");
  const reportSource = byId("article-report-source");
  let attachedCheck;
  let choices;
  let requested = false;
  let reading = false;
  let reportLoad = 0;
  const images = prepareImages(form.elements.text);

  function sync() {
    const busy = requested || reading;
    submit.disabled = busy || !platform.value;
    readButton.disabled = busy;
    source.readOnly = reading;
    form.elements.title.readOnly = reading;
    form.elements.text.readOnly = reading;
    byId("optimize-detach").disabled = busy;
    images.lock(busy);
  }

  function attach(check) {
    if (!requested && !reading && attachedCheck?.id !== check.id) {
      attachedCheck = check;
      source.value = check.url || "";
      readStatus.textContent = "";
      form.elements.title.value = check.name;
      form.elements.question.value = check.question ?? "";
      byId("optimize-context-title").textContent = check.name;
      context.hidden = false;
    }
    location.hash = "optimize";
  }

  function detach() {
    attachedCheck = undefined;
    context.hidden = true;
  }

  byId("optimize-detach").addEventListener("click", detach);
  platform.addEventListener("change", sync);

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
      const article = await api("/api/article-source", { url });
      images.replace(article.images);
      form.elements.title.value = article.title;
      form.elements.text.value = article.text;
      source.value = article.url;
      if (attachedCheck && ![url, article.url].includes(attachedCheck.url)) detach();
      const notes = [article.images.length ? "已读取正文和 " + article.images.length + " 张配图。" : "已读取标题和正文。"];
      if (article.omittedImages) notes.push(article.images.length ? "部分配图未导入，可手动上传。" : "配图未能导入，可手动上传。");
      if (article.truncated) notes.push("正文已截取前 12,000 字符，可以调整分析范围。");
      readStatus.textContent = notes.join("");
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
      const report = await api("/api/article-optimization", { ...payload, checkId: attachedCheck?.id, images: await images.payload() });
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
