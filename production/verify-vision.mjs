import { createGeoPlatforms } from "../geo-platforms.mjs";
import { createPool } from "./db.mjs";
import { verifyVision } from "./vision.mjs";

const platform = process.argv[2];
if (!platform) throw new Error("Usage: node production/verify-vision.mjs PLATFORM");
const pool = createPool(process.env.DATABASE_URL);
try {
  const verified = await verifyVision(pool, createGeoPlatforms(), platform);
  console.log(JSON.stringify({ platform, visionVerified: verified }));
  if (!verified) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ event: "vision_probe_failed", platform }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
