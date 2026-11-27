const $ = (selector) => document.querySelector(selector);

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function externalLink(text, href, className = "") {
  const link = element("a", text, className);
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}

function time(value) {
  if (!value) return "时间未标注";
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function empty(text) {
  return element("p", text, "radar-empty");
}

function newsCard(item) {
  const card = element("article", "", "radar-card news-card");
  const meta = element("div", "", "radar-meta");
  meta.append(element("span", item.source, "radar-source"), element("time", time(item.publishedAt)));
  card.append(meta, externalLink(item.title, item.url, "radar-title"));
  if (item.summary) card.append(element("p", item.summary, "radar-summary"));
  card.append(externalLink("阅读原文 ↗", item.url, "text-link radar-action"));
  return card;
}

function discussionRow(item) {
  const row = element("li", "", "radar-discussion");
  const copy = element("div");
  copy.append(externalLink(item.title, item.url, "radar-title"), element("p", time(item.publishedAt), "radar-summary"));
  const activity = element("div", "", "radar-activity");
  activity.append(element("strong", String(item.points)), element("span", "赞同"), element("strong", String(item.comments)), element("span", "讨论"));
  if (item.discussionUrl) activity.append(externalLink("参与讨论 ↗", item.discussionUrl, "text-link"));
  row.append(copy, activity);
  return row;
}

function toolCard(item) {
  const card = element("article", "", "radar-card tool-card");
  const meta = element("div", "", "radar-meta");
  meta.append(element("span", item.language || "开源工具", "radar-source"), element("span", "★ " + item.stars.toLocaleString("zh-CN")));
  card.append(meta, externalLink(item.title, item.url, "radar-title"));
  if (item.summary) card.append(element("p", item.summary, "radar-summary"));
  card.append(element("small", item.source + " · 最近更新 " + time(item.publishedAt)), externalLink("打开工具 ↗", item.url, "text-link radar-action"));
  return card;
}

export function setupAiRadar(api) {
  const refreshButton = $("#radar-refresh");
  const status = $("#radar-status");
  const sources = $("#radar-sources");
  const news = $("#radar-news");
  const discussions = $("#radar-discussions");
  const tools = $("#radar-tools");
  let loading = false;
  let loadedAt = 0;

  async function refresh(force = false) {
    if (loading || (!force && loadedAt && Date.now() - loadedAt < 10 * 60_000)) return;
    loading = true;
    refreshButton.disabled = true;
    status.textContent = force ? "正在刷新全球 AI 动态…" : "正在汇总全球 AI 动态…";
    status.classList.remove("error");
    try {
      const data = await api("/api/ai-radar" + (force ? "?refresh=1" : ""));
      loadedAt = Date.now();
      news.replaceChildren(...(data.news.length ? data.news.map(newsCard) : [empty("暂时没有读取到最新资讯。") ]));
      discussions.replaceChildren(...(data.discussions.length ? data.discussions.map(discussionRow) : [empty("暂时没有读取到社区热议。") ]));
      tools.replaceChildren(...(data.tools.length ? data.tools.map(toolCard) : [empty("暂时没有读取到工具榜。") ]));
      sources.replaceChildren(...data.sources.map((source) => {
        const pill = element("span", source.label, "radar-source-pill");
        pill.dataset.state = source.ok ? "ready" : source.stale ? "stale" : "offline";
        pill.title = source.ok ? "已更新" : source.stale ? "当前连接失败，展示上次结果" : source.error || "暂不可用";
        return pill;
      }));
      const ready = data.sources.filter((source) => source.ok).length;
      status.textContent = time(data.updatedAt) + " 更新 · " + ready + "/" + data.sources.length + " 个来源在线" +
        (data.partial ? " · 个别来源暂不可用，其他内容仍可正常查看" : "");
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("error");
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener("click", () => void refresh(true));
  return { refresh };
}
