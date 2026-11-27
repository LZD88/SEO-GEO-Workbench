import { containsConfiguredIdentity } from "../vendor/niubigeo/dist/src/prompts/brand-question.js";
import { citationKey } from "../geo-checks.mjs";

function uniqueEvidence(successes) {
  const entries = new Map();
  for (const [index, sample] of successes.entries()) {
    const key = sample.evidenceId ?? index;
    if (!entries.has(key)) entries.set(key, sample);
  }
  return [...entries.values()];
}

function rate(count, eligible) {
  return { count, eligible, rate: eligible ? count / eligible : null };
}

function entityMetrics(job, samples) {
  const target = { name: job.input.name, aliases: [], domains: [new URL(job.input.url).hostname] };
  const entities = [target, ...(job.input.competitors ?? [])].map((entity) => ({
    ...entity,
    identities: [...new Set([entity.name, ...entity.aliases])],
  }));
  const identityOwners = new Map();
  for (const entity of entities) {
    for (const identity of entity.identities) {
      const label = identity.toLocaleLowerCase();
      identityOwners.set(label, (identityOwners.get(label) ?? 0) + 1);
    }
  }
  return entities.map((entity, index) => {
    const mentions = { hits: [], excluded: 0 };
    const sources = new Map();
    let cited = 0;
    for (const sample of samples) {
      const matching = entity.identities.filter((identity) => containsConfiguredIdentity(sample.answer, identity));
      if (matching.some((identity) => identityOwners.get(identity.toLocaleLowerCase()) === 1)) {
        mentions.hits.push(sample.evidenceId);
      } else if (matching.length) {
        mentions.excluded++;
      }
      const evidence = new Set();
      for (const source of sample.sources ?? []) {
        if (source.type !== "citation") continue;
        let page;
        try { page = new URL(source.url); } catch { continue; }
        const belongs = index === 0 && job.input.kind === "article"
          ? citationKey(page) === citationKey(job.input.url)
          : entity.domains.includes(page.hostname);
        if (!belongs || evidence.has(page.href)) continue;
        evidence.add(page.href);
        const same = sources.get(page.href) ?? { url: source.url, evidence: [] };
        same.evidence.push(sample.evidenceId);
        sources.set(page.href, same);
      }
      if (evidence.size) cited++;
    }
    return {
      name: entity.name,
      mention: { ...rate(mentions.hits.length, samples.length - mentions.excluded), excluded: mentions.excluded, evidence: mentions.hits },
      cited: rate(cited, samples.length),
      sources: [...sources.values()].sort((a, b) => b.evidence.length - a.evidence.length),
    };
  });
}

export function geoMeasurement(job) {
  if (job.kind !== "geo" || !job.input?.configuration || !job.input.url) return null;
  const minimumCoverage = job.input.minimumCoverage ?? 0.8;
  return job.input.configuration.map((config) => {
    const planned = job.steps.filter((step) => step.channel === config.id);
    const valid = uniqueEvidence(planned.filter((step) => step.state === "succeeded" && step.result?.answer).map((step) => step.result));
    const coverage = planned.length ? valid.length / planned.length : 0;
    const models = [...new Set(valid.map((sample) => sample.modelVersion ?? "unknown"))].sort();
    const search = [...new Set(valid.map((sample) => sample.searchStatus ?? "unconfirmed"))].sort();
    return {
      id: config.id, config, models, search, coverage,
      planned: planned.length, valid: valid.length,
      failed: planned.filter((step) => step.state === "failed").length,
      pending: planned.filter((step) => ["queued", "running"].includes(step.state)).length,
      awaitingReview: planned.filter((step) => step.state === "review").length,
      confirmedSearch: valid.filter((sample) => sample.searchStatus === "confirmed").length,
      nativeCitations: rate(valid.filter((sample) => sample.cited).length, valid.length),
      textLinks: rate(valid.filter((sample) => sample.textMatch).length, valid.length),
      comparable: coverage >= minimumCoverage && models.length === 1 && models[0] !== "unknown" && search.length === 1,
      entities: entityMetrics(job, valid),
    };
  });
}

function sameConditions(previous, current) {
  const fields = ["kind", "name", "url", "promptVersion", "sampleCount", "language", "monitorId", "questionSetVersion"];
  return fields.every((field) => previous[field] === current[field]) &&
    JSON.stringify(previous.questions ?? [previous.question]) === JSON.stringify(current.questions ?? [current.question]) &&
    JSON.stringify(previous.competitors ?? []) === JSON.stringify(current.competitors ?? []);
}

export function geoComparison(previous, current) {
  const baseline = geoMeasurement(previous);
  const measured = geoMeasurement(current);
  if (!baseline || !measured) return [];
  const matching = sameConditions(previous.input, current.input);
  return measured.map((now) => {
    const before = baseline.find(({ id }) => id === now.id);
    if (!before || !matching) return { id: now.id, status: "configuration_changed" };
    if (now.config.routeFingerprint !== before.config.routeFingerprint || now.config.channelType !== before.config.channelType ||
        now.config.model !== before.config.model || now.config.search !== before.config.search) {
      return { id: now.id, status: "configuration_changed" };
    }
    const knownBefore = before.models.filter((model) => model !== "unknown");
    const knownNow = now.models.filter((model) => model !== "unknown");
    if ((knownBefore.length && knownNow.length && knownBefore.join() !== knownNow.join()) ||
        (now.search.length && before.search.length && now.search.join() !== before.search.join())) {
      return { id: now.id, status: "configuration_changed" };
    }
    if (!before.comparable || !now.comparable) return { id: now.id, status: "insufficient_samples" };
    return {
      id: now.id, status: "comparable",
      citationDifference: now.nativeCitations.rate - before.nativeCitations.rate,
      mentionDifference: now.entities[0].mention.rate !== null && before.entities[0].mention.rate !== null
        ? now.entities[0].mention.rate - before.entities[0].mention.rate : null,
    };
  });
}
