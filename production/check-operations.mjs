import { createPool } from "./db.mjs";
import { operationalStatus } from "./operations.mjs";

const db = createPool(process.env.DATABASE_URL);
try {
  const status = await operationalStatus(db);
  const result = {
    ...status,
    alerts: [
      ...status.queues.filter((item) => item.oldest_queue_seconds > 60)
        .map(({ kind }) => ({ code: "queue_delay", kind })),
      ...status.failures.filter((item) => item.count >= 5)
        .map(({ channel, error_category }) => ({ code: "upstream_failures", channel, category: error_category })),
      ...status.usage.filter((item) => item.awaiting_review > 0)
        .map(({ category }) => ({ code: "usage_review", category })),
    ],
  };
  console.log(JSON.stringify(result));
  if (result.alerts.length) process.exitCode = 2;
} finally { await db.end(); }
