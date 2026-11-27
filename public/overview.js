const $ = (id) => document.getElementById(id);
const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const dateLabel = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" });
const recentStates = { running: "进行中", completed: "已完成", failed: "失败", interrupted: "已中断", legacy: "历史记录" };
const dayTime = 86400000;

function node(tag, text, name) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (name) item.className = name;
  return item;
}

function recentRow(title, detail, note, tone) {
  const row = node("li");
  const caption = node("div", "", "dash-caption");
  caption.append(node("strong", title), node("small", detail));
  row.append(caption, node("span", note, "dash-status " + tone));
  return row;
}

function chartSvg(tag, attributes) {
  const item = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  return item;
}

function heatmap(rows, max) {
  const view = node("div", "", "heatmap");
  for (const day of ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]) {
    view.append(node("span", day, "heat-heading"));
  }
  const firstDay = (new Date(rows[0].key + "T00:00:00Z").getUTCDay() + 6) % 7;
  for (let i = 0; i < firstDay; i++) {
    const gap = node("span");
    gap.setAttribute("aria-hidden", "true");
    view.append(gap);
  }
  for (const { key, total } of rows) {
    const label = key === rows[0].key || key.endsWith("-01")
      ? Number(key.slice(5, 7)) + "/" + Number(key.slice(-2))
      : String(Number(key.slice(-2)));
    const day = node("span", label, "heat-cell");
    day.dataset.level = total ? String(Math.ceil(total * 4 / max)) : "0";
    day.title = key + " · " + total + " 次检测";
    day.setAttribute("aria-label", day.title);
    if (key === rows.at(-1).key) day.setAttribute("aria-current", "date");
    view.append(day);
  }
  return view;
}

function lineChart(rows, max) {
  const area = node("div", "", "line-chart");
  const svg = chartSvg("svg", { viewBox: "0 0 620 196", role: "img", "aria-label": "检测次数趋势" });
  const left = 32;
  const right = 601;
  const peak = Math.max(max, 1);
  const baseline = 168;
  const top = 16;
  const coords = rows.map(({ total }, i) => [
    left + i / (rows.length - 1) * (right - left),
    baseline - total / peak * (baseline - top),
  ]);
  for (const fraction of [0, .5, 1]) {
    const y = baseline - (baseline - top) * fraction;
    svg.append(chartSvg("line", { x1: left, x2: right, y1: y, y2: y, class: "chart-grid" }));
    const label = chartSvg("text", { x: 0, y: y + 4, class: "chart-label" });
    label.textContent = String(peak * fraction);
    svg.append(label);
  }
  const points = coords.map(([x, y]) => x + "," + y).join(" ");
  svg.append(chartSvg("polygon", { points: left + "," + baseline + " " + points + " " + right + "," + baseline, class: "chart-area" }));
  svg.append(chartSvg("polyline", { points, class: "chart-line" }));
  for (let i = 0; i < coords.length; i++) {
    const [cx, cy] = coords[i];
    const dot = chartSvg("circle", { cx, cy, r: rows[i].total ? 4 : 2, class: "chart-dot" });
    const title = chartSvg("title", {});
    title.textContent = rows[i].key + " · " + rows[i].total + " 次检测";
    dot.append(title);
    svg.append(dot);
  }
  const axis = node("div", "", "chart-axis");
  axis.append(node("span", rows[0].key.slice(5)), node("span", rows.at(-1).key.slice(5)));
  area.append(svg, axis);
  return area;
}

export function setupOverview(api) {
  let data;
  let rendered = "";
  let platformStamp;
  let range = 30;
  let chart = "heat";
  let request = 0;
  let refreshedAt = 0;

  function render() {
    if (!data) return;
    const now = Date.now();
    const key = dateKey.format(now);
    const stamp = JSON.stringify([data, key, range, chart]);
    if (stamp === rendered) return;
    rendered = stamp;
    const days = Array.from({ length: 30 }, (_, i) => {
      const key = dateKey.format(now - (29 - i) * dayTime);
      const { geo = 0, seo = 0, completed = 0, running = 0 } = data.days[key] || {};
      return { key, geo, seo, completed, running, total: geo + seo };
    });
    const rows = days.slice(-range);
    const sum = (items, name) => items.reduce((total, item) => total + item[name], 0);
    const max = Math.max(...rows.map((item) => item.total));
    $("overview-date").textContent = dateLabel.format(now);
    $("today-count").textContent = days.at(-1).total;
    $("completed-count").textContent = sum(days, "completed");
    $("geo-total").textContent = sum(rows, "geo");
    $("seo-total").textContent = sum(rows, "seo");
    $("running-total").textContent = sum(rows, "running");
    $("activity-summary").textContent = "近 " + range + " 天 · " + sum(rows, "total") + " 次检测 · " + rows.filter((item) => item.total).length + " 天有记录";
    $("heat-legend").hidden = chart !== "heat";
    $("activity").replaceChildren(chart === "heat" ? heatmap(rows, max) : lineChart(rows, max));
    $("recent-runs").replaceChildren(...(data.recent.length ? data.recent.map((row) =>
      recentRow(row.name, (row.type === "seo" ? "SEO 审计" : "GEO 检测") + " · " + dateLabel.format(new Date(row.createdAt)), recentStates[row.status] || "已记录", row.status === "completed" ? "ready" : "")
    ) : [node("li", "暂无检测记录，发起一次检测后会显示在这里。", "dash-empty")]));
  }

  for (const button of document.querySelectorAll("[data-range], [data-chart]")) {
    button.addEventListener("click", () => {
      const kind = button.dataset.range ? "range" : "chart";
      if (kind === "range") range = Number(button.dataset.range);
      else chart = button.dataset.chart;
      for (const option of document.querySelectorAll("[data-" + kind + "]")) {
        option.setAttribute("aria-pressed", String(option === button));
      }
      render();
    });
  }

  return {
    async refresh(force = false) {
      if (!force && Date.now() - refreshedAt < 10000) return;
      refreshedAt = Date.now();
      const revision = ++request;
      try {
        const fresh = await api("/api/overview");
        if (revision !== request) return;
        $("overview-message").textContent = "";
        data = fresh;
        render();
      } catch {
        if (revision === request) $("overview-message").textContent = "暂时无法加载检测统计。";
      }
    },
    platforms(platforms) {
      const stamp = JSON.stringify(platforms);
      if (stamp === platformStamp) return;
      platformStamp = stamp;
      const ready = platforms.filter((item) => item.ready).length;
      $("platform-count").textContent = ready + " / " + platforms.length;
      $("coverage-fill").style.width = (platforms.length ? ready * 100 / platforms.length : 0) + "%";
      $("overview-platforms").replaceChildren(...platforms.map((item) => {
        const row = recentRow(item.label, "", item.ready ? "可用" : "暂不可用", item.ready ? "ready" : "");
        const icon = node("img");
        icon.alt = "";
        icon.src = "/platform-icons/" + item.id + (["gpt", "gemini"].includes(item.id) ? ".svg" : ".png");
        row.prepend(icon);
        return row;
      }));
    },
  };
}
