import { initTheme } from "./theme.js";

initTheme();
const loginPage = location.pathname === "/login";
document.querySelector("#home").hidden = loginPage;
document.querySelector("#login").hidden = !loginPage;

async function session(path, payload) {
  const options = payload ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  } : undefined;
  const response = await fetch("/api/" + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "暂时无法登录，请重试。");
  return data;
}

async function setupLogin() {
  const form = document.querySelector("#login-form");
  const button = document.querySelector("#login-button");
  const errorBox = document.querySelector("#login-error");
  try {
    const { signedIn, needsSetup } = await session("session");
    if (signedIn) return location.replace("/dashboard");
    document.title = needsSetup ? "设置密码 · 曜见" : "登录 · 曜见";
    document.querySelector("#login-title").textContent = needsSetup ? "设置工作台密码" : "欢迎回来";
    document.querySelector("#login-description").textContent = needsSetup
      ? "首次使用，请设置至少 8 个字符的本机工作台密码。"
      : "输入密码，继续查看网站检测和报告。";
    document.querySelector("#confirm-field").hidden = !needsSetup;
    form.elements.confirm.required = needsSetup;
    form.elements.password.autocomplete = needsSetup ? "new-password" : "current-password";
    button.textContent = needsSetup ? "设置并进入 ↗" : "登录工作台 ↗";
    button.disabled = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      const payload = Object.fromEntries(new FormData(form));
      if (needsSetup && payload.confirm !== payload.password) {
        errorBox.textContent = "两次输入的密码不一致。";
        return;
      }
      errorBox.textContent = "";
      button.disabled = true;
      try {
        await session(needsSetup ? "setup" : "login", payload);
        location.replace("/dashboard");
      } catch (error) {
        errorBox.textContent = error.message || "暂时无法登录，请重试。";
        button.disabled = false;
      }
    });
  } catch {
    errorBox.textContent = "暂时无法连接工作台，请刷新重试。";
  }
}

function animateSignal() {
  const canvas = document.querySelector("#signal");
  const scene = canvas.closest("figure");
  const ctx = canvas.getContext("2d");
  const toggle = document.querySelector("#motion-toggle");
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  let paused = preference.matches;
  let visible = false;
  let frame = 0;
  let clock = 0;
  let prior = 0;
  let width, height;
  let offset = 0;

  function draw() {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const t = clock * 0.0006;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    for (const [stop, color] of [[0, "#34d4e122"], [.25, "#6bc5ffa1"], [.5, "#c3eafff0"], [.74, "#67adbbc9"], [1, "#55dffa25"]]) gradient.addColorStop(stop, color);
    ctx.strokeStyle = gradient;
    for (let j = 0; j < 43; j += 1) {
      const phase = j * .052;
      ctx.beginPath();
      for (let x = 0; x <= width + 8; x += 7) {
        const u = x / width;
        const drift = Math.sin(u * 5.1 + t * .9 + phase) * .23;
        const curl = Math.sin(u * 10.5 - t * .73 + phase * 1.7) * (.06 + .07 * Math.sin(Math.PI * u));
        const s = .57 + drift + curl + (j - 21) * .005 + offset * Math.sin(Math.PI * u) * .09;
        if (!x) ctx.moveTo(x, s * height);
        else ctx.lineTo(x, s * height);
      }
      ctx.lineWidth = j % 8 === 0 ? 1.45 : .7;
      ctx.globalAlpha = j % 8 === 0 ? .92 : .47;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function tick(now) {
    frame = 0;
    if (!visible || paused || document.hidden) return;
    if (prior) clock += Math.min(now - prior, 40);
    prior = now;
    draw();
    frame = requestAnimationFrame(tick);
  }

  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    prior = 0;
    scene.dataset.paused = String(paused);
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? "播放动效" : "暂停动效";
    draw();
    if (visible && !paused && !document.hidden) frame = requestAnimationFrame(tick);
  }

  new ResizeObserver(() => {
    ({ width, height } = scene.getBoundingClientRect());
    const scale = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    draw();
  }).observe(scene);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }).observe(scene);
  document.addEventListener("visibilitychange", sync);
  preference.addEventListener("change", () => { paused = preference.matches; sync(); });
  toggle.addEventListener("click", () => { paused = !paused; sync(); });
  scene.addEventListener("pointermove", (event) => {
    if (!paused) offset = (event.clientY - scene.getBoundingClientRect().top) / height - .5;
  });
  scene.addEventListener("pointerleave", () => { offset = 0; });
  sync();
}

if (loginPage) void setupLogin();
else {
  animateSignal();
  session("session").then(({ signedIn }) => {
    if (signedIn) for (const link of document.querySelectorAll("[data-session-link]")) {
      link.href = "/dashboard";
      if (link.textContent === "登录") link.textContent = "工作台";
    }
  }).catch(() => {});
}
