import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGeoPlatforms } from "../geo-platforms.mjs";

const run = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
export const lockedVersions = JSON.parse(await readFile(new URL("./dependencies.json", import.meta.url), "utf8"));

export async function crawlerPath() {
  if (process.platform !== "win32") return join(project, "vendor", "siteone-crawler");
  const directory = join(project, "vendor", "siteone");
  const file = (await readdir(directory, { recursive: true })).find((name) => /(?:^|[/\\])siteone-crawler\.exe$/i.test(name));
  if (!file) throw new Error("SiteOne executable is missing");
  return join(directory, file);
}

export async function verifyRuntime() {
  if (process.versions.node !== lockedVersions.node) {
    throw new Error("Production requires Node.js " + lockedVersions.node);
  }
  const binary = await crawlerPath();
  await access(binary, constants.X_OK);
  const { stdout, stderr } = await run(binary, ["--version"], { timeout: 10000, windowsHide: true }).catch((error) => {
    // SiteOne prints version information and exits with status 2.
    if (error.code === 2) return error;
    throw error;
  });
  if (!(stdout + stderr).includes(lockedVersions.siteone.version)) throw new Error("Unexpected SiteOne version");
  createGeoPlatforms({});
  return {
    status: "ok",
    node: process.versions.node,
    niubigeoCommit: lockedVersions.niubigeo,
    siteone: lockedVersions.siteone.version,
  };
}
