import index from "../web/index.html";
import { fetchHandler } from "./api";
import { init, initHub, runner, scheduler } from "./app";
import { config } from "./config";
import { gateway } from "./devices/gateway";
import { isHub } from "./hub/mode";
import { stopHubSync } from "./hub/sync";

const hub = isHub();
await (hub ? initHub() : init());

/** Every legitimate local body is a brief, a steer message or a suite: far below this. Bun's default is 128 MB. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
/** A hub takes screenshots and run documents; the ingest routes enforce their own, smaller caps (blobs 16 MB, documents 2 MB decoded). */
const HUB_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Seconds without any traffic after which a hub closes a connection (Bun allows at most 255). */
const HUB_IDLE_TIMEOUT_S = 120;

const server = Bun.serve({
  // A laptop listens on loopback only. A hub is reached through an access proxy, so its bind address is configurable
  // (the container sets 0.0.0.0 and does not publish the port: only the proxy container can connect).
  hostname: hub ? process.env.TAPOCALYPSE_HOST || "127.0.0.1" : "127.0.0.1",
  port: config.port,
  // A hub faces many clients behind a proxy: drop connections that go quiet (slow-loris). Event streams opt out per request.
  idleTimeout: hub ? HUB_IDLE_TIMEOUT_S : 0,
  maxRequestBodySize: hub ? HUB_MAX_REQUEST_BODY_BYTES : MAX_REQUEST_BODY_BYTES,
  // The HTMLBundle route is served by Bun without going through `fetch`, so "/" cannot get the framing headers that
  // fetchHandler adds to every other response; it is protected by the meta CSP and frame-guard script in web/index.html.
  routes: { "/": index },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  fetch: (req, srv) => fetchHandler(req, srv),
});

console.log(`tapocalypse ${hub ? "team hub " : ""}listening on http://${server.hostname}:${server.port}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    if (hub) {
      await server.stop(true).catch(() => {});
      process.exit(0);
    }
    // Stop scheduling first so exiting omp processes cannot free a slot that starts the next queued run.
    scheduler.stop();
    runner.killAll();
    await stopHubSync().catch(() => {});
    // Then stop accepting requests (dropping open connections, SSE streams included): a gated call arriving while the
    // gateway closes its children could otherwise spawn one that nothing stops.
    await server.stop(true).catch(() => {});
    await gateway.stopAll().catch(() => {});
    await Bun.sleep(500);
    process.exit(0);
  });
}
