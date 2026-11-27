import { normalizeGeoTarget, measureGeoSample, modelFailureMessage, promptVersion } from "../geo-checks.mjs";
import { HttpError } from "./http.mjs";
import { getJob } from "./jobs.mjs";

const sampleCounts = [1, 3, 5];

function channelStep(check, id, number, prior) {
  return {
    channel: id,
    category: "model_limit",
    estimate: prior ? 0 : 1,
    input: { check, platformId: id, number },
    ...(prior && { prior: { ...prior, retained: true } }),
  };
}

export function prepareGeo(payload, platforms) {
  const target = normalizeGeoTarget(payload);
  const count = payload.sampleCount ?? 1;
  if (!sampleCounts.includes(count)) throw new HttpError(400, "每个平台可选择 1、3 或 5 次采样。");
  if (payload.webSearch !== undefined && typeof payload.webSearch !== "boolean") {
    throw new HttpError(400, "联网选项无效。");
  }
  const ids = payload.platforms;
  const available = new Map(platforms.list().map((platform) => [platform.id, platform]));
  if (!Array.isArray(ids) || !ids.length || ids.length > available.size ||
      new Set(ids).size !== ids.length || ids.some((id) => !available.has(id))) {
    throw new HttpError(400, "请选择可用平台。");
  }
  if (ids.some((id) => !available.get(id).ready)) throw new HttpError(409, "所选模型尚未配置。");
  if (payload.webSearch && !ids.some((id) => available.get(id).search)) {
    throw new HttpError(409, "请至少选择一个支持联网的模型。");
  }
  const configuration = ids.map((id) => ({
    ...platforms.configuration(id),
    search: payload.webSearch === true && available.get(id).search,
  }));
  const input = { ...target, promptVersion, language: "zh-CN", sampleCount: count, configuration };
  const steps = ids.flatMap((id) => Array.from({ length: count }, (_, index) => channelStep(input, id, index + 1)));
  return { input, steps };
}

function matchesConfig(platforms, expected) {
  const listed = platforms.list().find(({ id }) => id === expected.id);
  if (!listed?.ready) return false;
  const current = platforms.configuration(expected.id);
  return expected.model === current.model && expected.routeFingerprint === current.routeFingerprint &&
    (!expected.search || current.search);
}

export async function prepareRetest(db, scope, payload, platforms) {
  const job = await getJob(db, { ...scope, jobId: payload.baselineId, includeStepInputs: true });
  if (job.kind !== "geo") throw new HttpError(404, "资源不存在。");
  if (["queued", "running"].includes(job.status)) throw new HttpError(409, "请等待本次检测完成。");
  const failedOnly = payload.failedOnly === true;
  if (job.input.promptVersion !== promptVersion || !job.input.configuration?.length) {
    if (failedOnly || payload.useCurrentConfiguration !== true || !job.input.historical) {
      throw new HttpError(409, "基线条件未知，请选择按当前配置复测。");
    }
    const available = platforms.list();
    const ids = [...new Set(job.steps.map((step) => available.find(({ id, label }) =>
      id === step.channel || label === step.result?.model)?.id))].filter(Boolean);
    if (!ids.length) throw new HttpError(409, "没有可映射的历史渠道，请新建检测。");
    const prepared = prepareGeo({ ...job.input, platforms: ids, sampleCount: job.input.sampleCount ?? 1 }, platforms);
    return { ...prepared, input: { ...prepared.input, comparisonMode: "legacy" }, baselineId: job.id };
  }
  if (failedOnly && (!job.steps.some((step) => step.state === "failed") ||
      job.steps.some((step) => !["failed", "succeeded"].includes(step.state)))) {
    throw new HttpError(409, "没有可确认安全补跑的失败样本。");
  }
  const needed = new Set(job.steps.filter((step) => !failedOnly || step.state === "failed").map((step) => step.channel));
  if (job.input.configuration.some((config) => needed.has(config.id) && !matchesConfig(platforms, config))) {
    throw new HttpError(409, "模型或联网渠道已变化，需要新建检测。");
  }
  const steps = job.steps.map((step) => {
    const next = channelStep(step.input.check, step.channel, step.input.number,
      failedOnly && step.state === "succeeded" ? step.result : undefined);
    next.input = step.input;
    return next;
  });
  return { input: { ...job.input, comparisonMode: failedOnly ? "retry" : "matched" }, steps, baselineId: job.id };
}

export function modelOutcome(error, attempts) {
  if ((error?.code === "rate_limited" || error?.status === 429) && attempts < 3) return { state: "queued", category: "rate_limit" };
  if (error?.code === "empty_answer") return { state: "failed", category: "empty_answer", units: 1 };
  if ([400, 401, 402, 403, 404, 422, 429].includes(error?.status) && error?.code !== "invalid_response") {
    return { state: "failed", category: "upstream_rejected", units: 0 };
  }
  return { state: "review", category: "provider_outcome_unknown" };
}

export async function executeGeo(step, platforms) {
  const { check, platformId, number } = step.input;
  const expected = check.configuration.find(({ id }) => id === platformId);
  if (!expected || !matchesConfig(platforms, expected)) {
    return { state: "failed", units: 0, category: "model_configuration_changed" };
  }
  const platform = platforms.list().find(({ id }) => id === platformId);
  try {
    const sample = await measureGeoSample(check, platforms, platform, number, expected.search);
    return {
      state: "succeeded", units: 1,
      result: {
        ...sample,
        channelType: expected.channelType,
        configuredModel: expected.model,
        evidenceId: step.job_id + ":" + step.step_index,
        questionIndex: step.input.questionIndex ?? 0,
        searchRequested: expected.search,
        searchStatus: sample.usedSearch === true ? "confirmed" : expected.search ? "unconfirmed" : "off",
      },
    };
  } catch (error) {
    const outcome = modelOutcome(error, step.attempts);
    return { ...outcome, result: { number, platformId, model: platform.label, error: modelFailureMessage(error) } };
  }
}
