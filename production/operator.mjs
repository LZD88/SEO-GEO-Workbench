import { createPool } from "./db.mjs";
import { operationalStatus, setChannelPaused, setProjectPaused, setWorkspaceLimits } from "./operations.mjs";

const [command, ...args] = process.argv.slice(2);
function pauseValue(value) {
  if (value === "pause") return true;
  if (value === "resume") return false;
  throw new Error("Expected pause or resume");
}

const db = createPool(process.env.DATABASE_URL);
try {
  let report;
  if (command === "status") {
    report = await operationalStatus(db);
  } else if (command === "channel" && args.length === 2) {
    report = await setChannelPaused(db, args[0], pauseValue(args[1]));
  } else if (command === "project" && args.length === 3) {
    report = await setProjectPaused(db, args[0], args[1], pauseValue(args[2]));
  } else if (command === "limits" && args.length === 5) {
    const [workspaceId, model, pages, articles, active] = args;
    report = await setWorkspaceLimits(db, workspaceId, {
      model: Number(model), pages: Number(pages), articles: Number(articles), active: Number(active),
    });
  } else {
    throw new Error("Usage: operator.mjs status | channel ID pause|resume | project WORKSPACE PROJECT pause|resume | limits WORKSPACE MODEL PAGES ARTICLES ACTIVE");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.end();
}
