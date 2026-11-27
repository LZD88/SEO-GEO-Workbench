import { createGeoPlatforms } from "../geo-platforms.mjs";
import { createPool, databaseVersion } from "./db.mjs";
import { executeGeo } from "./geo.mjs";
import { createArticleHandlers } from "./article-jobs.mjs";
import { createArtifactStore } from "./artifacts.mjs";
import { work } from "./worker-loop.mjs";
import { createSeoHandler } from "./seo-jobs.mjs";
import { prepareSeo } from "./sites.mjs";
import { dueMonitor, prepareGeoMonitor } from "./monitoring.mjs";

const pool = createPool(process.env.DATABASE_URL);
pool.on("error", () => console.error(JSON.stringify({ event: "database_connection_failed" })));
const platforms = createGeoPlatforms();
const { ARTIFACT_BUCKET: bucket, ARTIFACT_REGION: region, ARTIFACT_ENDPOINT: endpoint } = process.env;
const artifacts = bucket ? createArtifactStore({ bucket, region, endpoint }) : undefined;
const services = { fetchService: process.env.FETCH_SERVICE_URL, token: process.env.FETCH_SERVICE_TOKEN, artifacts };
const handlers = {
  geo: (step) => executeGeo(step, platforms),
  seo: createSeoHandler(pool, services),
  ...createArticleHandlers(pool, platforms, services),
};
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());
try {
  if ((await databaseVersion(pool)) < 7) throw new Error("Apply the production migrations before starting the worker");
  const tick = process.env.SCHEDULE_ENABLED === "true"
    ? () => dueMonitor(pool, (db, scope, kind, configuration) =>
      kind === "seo" ? prepareSeo(db, scope, configuration) : prepareGeoMonitor(configuration, platforms))
    : undefined;
  await work(pool, handlers, { signal: stop.signal, tick });
} finally {
  artifacts?.close();
  await pool.end();
}
