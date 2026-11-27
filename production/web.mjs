import { createOidc } from "./auth.mjs";
import { createGeoPlatforms } from "../geo-platforms.mjs";
import { createArtifactStore } from "./artifacts.mjs";
import { createPool, databaseVersion } from "./db.mjs";
import { verifyRuntime } from "./runtime.mjs";
import { createProductionServer } from "./server.mjs";

const runtime = await verifyRuntime();
if (process.argv.includes("--check")) {
  console.log(JSON.stringify(runtime));
} else {
  const origin = new URL(process.env.PUBLIC_ORIGIN);
  if (origin.protocol !== "https:" || origin.href !== origin.origin + "/") throw new Error("PUBLIC_ORIGIN must be an HTTPS origin");
  const port = Number(process.env.PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const pool = createPool(process.env.DATABASE_URL);
  pool.on("error", () => console.error(JSON.stringify({ event: "database_connection_failed" })));
  const settings = createOidc({
    issuer: process.env.OIDC_ISSUER,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
  });
  const readiness = async () => {
    try { return (await databaseVersion(pool)) >= 5; }
    catch { return false; }
  };
  const platforms = createGeoPlatforms();
  const { ARTIFACT_BUCKET: bucket, ARTIFACT_REGION: region, ARTIFACT_ENDPOINT: endpoint } = process.env;
  const artifacts = bucket ? createArtifactStore({ bucket, region, endpoint }) : undefined;
  const server = createProductionServer({
    pool, origin, settings, readiness, platforms, artifacts, sourceReady: Boolean(process.env.FETCH_SERVICE_URL),
  });
  server.listen(port, process.env.BIND_HOST ?? "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    server.close(() => { artifacts?.close(); void pool.end(); });
  });
}
