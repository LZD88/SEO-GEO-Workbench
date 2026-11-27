import { createFetchServer } from "./fetch-server.mjs";

if (process.env.FETCH_NETWORK_ISOLATED !== "1") throw new Error("Start the fetcher with its restricted network entrypoint");
const server = createFetchServer({ token: process.env.FETCH_SERVICE_TOKEN });
server.listen(8791, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
