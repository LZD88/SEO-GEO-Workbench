export const maintenanceAnnouncement = "曜见正在维护，服务恢复后即可继续使用。";

const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

export function renderMaintenance(message) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>服务维护中 · 曜见 YaoSight</title>
  <link rel="stylesheet" href="/admin-console.css">
</head>
<body class="maintenance-screen">
  <main class="maintenance-card">
    <p class="brand"><span class="brand-icon" aria-hidden="true">Y</span> 曜见 <small>YaoSight</small></p>
    <h1>服务维护中</h1>
    <p class="maintenance-message">${escapeHtml(message || maintenanceAnnouncement)}</p>
    <a class="primary button-link" href="/home">重新访问</a>
  </main>
</body>
</html>`;
}
