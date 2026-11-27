export function articleAdvice(samples) {
  const successful = samples.filter((sample) => !sample.pending && !sample.error && (sample.answer || sample.cited || sample.textMatch));
  if (!successful.length) return [["稍后再试", "可以换一个 AI 平台，或等服务恢复后再检测。"]];
  const advice = successful.some((sample) => sample.cited)
    ? [["保留已被引用的原文入口", "保留被引用的网址，及时更新对应段落。用相同的问题复测，观察引用是否持续。"]]
    : successful.some((sample) => sample.textMatch)
      ? [["核对平台的来源列表", "回答正文出现了原文链接。用相同的问题复测，留意链接是否也出现在来源列表里。"]]
      : [["让原文直接回答检测问题", "在开头给出一段能够独立理解的答案，再用贴合问题的小标题组织步骤、示例和来源。"]];
  if (samples.some((sample) => sample.error)) {
    advice.push(["重试未返回的平台", "在检测结果中重试暂未返回的平台，再比较结果。"]);
  }
  return advice;
}

export function hasArticleEvidence(check) {
  return check?.kind === "article" && ["completed", "succeeded", "partial", "review"].includes(check.state)
    && check.samples.some((sample) => !sample.pending && !sample.error && Boolean(sample.answer || sample.cited || sample.textMatch));
}
