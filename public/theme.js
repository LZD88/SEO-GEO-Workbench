export function initTheme() {
  const root = document.documentElement;
  const buttons = document.querySelectorAll("[data-theme-toggle]");
  function apply(dark) {
    root.dataset.theme = dark ? "dark" : "light";
    for (const button of buttons) button.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
  }
  apply(localStorage.getItem("yaosight-theme") === "dark");
  for (const button of buttons) button.addEventListener("click", () => {
    const dark = root.dataset.theme !== "dark";
    localStorage.setItem("yaosight-theme", dark ? "dark" : "light");
    apply(dark);
  });
}
