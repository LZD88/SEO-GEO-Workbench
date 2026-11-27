import { setTimeout as delay } from "node:timers/promises";
import { claim, finishStep, heartbeat, takeStep } from "./jobs.mjs";

const defaultLog = (value) => console.log(JSON.stringify(value));

export async function runJob(pool, handlers, { log = defaultLog, leaseSeconds = 30, signal } = {}) {
  const job = await claim(pool, leaseSeconds);
  if (!job) return false;
  let leaseAlive = true;
  let renewing = false;
  const interval = setInterval(async () => {
    if (renewing || !leaseAlive) return;
    renewing = true;
    try { leaseAlive = await heartbeat(pool, job, leaseSeconds); }
    catch { leaseAlive = false; }
    finally { renewing = false; }
  }, Math.max(250, Math.floor(leaseSeconds * 1000 / 3)));
  interval.unref();
  log({ event: "job_claimed", jobId: job.id, kind: job.kind, queueMs: +job.first_claimed_at - +job.created_at });
  try {
    while (leaseAlive && !signal?.aborted) {
      const step = await takeStep(pool, job);
      if (!step) break;
      let outcome;
      try {
        outcome = await handlers[job.kind](step, job);
      } catch {
        outcome = { state: "review", category: "execution_outcome_unknown" };
      }
      if (!leaseAlive || !(await finishStep(pool, job, step, outcome))) break;
      log({
        event: "job_step", jobId: job.id, kind: job.kind, channel: step.channel,
        state: outcome.state, category: outcome.category, units: outcome.units,
      });
    }
  } finally {
    clearInterval(interval);
  }
  return true;
}

export async function work(pool, handlers, { signal, log = defaultLog, tick, idleMs = 750 } = {}) {
  while (!signal?.aborted) {
    try {
      await tick?.();
      if (await runJob(pool, handlers, { log, signal })) continue;
    } catch {
      log({ event: "worker_failure", category: "internal" });
    }
    await delay(idleMs, undefined, { signal }).catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
  }
}
