export function radarTextKey(title, summary) {
  return JSON.stringify([title || "", summary || ""]);
}
