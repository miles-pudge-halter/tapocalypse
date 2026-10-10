import index from "../web/index.html";
import { fetchHandler } from "./api";
import { init, runner, scheduler } from "./app";
import { config } from "./config";
import { gateway } from "./devices/gateway";

init();

/** Every legitimate body is a brief, a steer message or a suite: far below this. Bun's default is 128 MB. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  idleTimeout: 0,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  // The HTMLBundle route is served by Bun without going through `fetch`, so "/" cannot get the framing headers that
  // fetchHandler adds to every other response; it is protected by the meta CSP and frame-guard script in web/index.html.
  routes: { "/": index },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  fetch: fetchHandler,
});

console.log(`tapocalypse listening on http://127.0.0.1:${server.port}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    // Stop scheduling first so exiting omp processes cannot free a slot that starts the next queued run.
    scheduler.stop();
    runner.killAll();
    // Then stop accepting requests (dropping open connections, SSE streams included): a gated call arriving while the
    // gateway closes its children could otherwise spawn one that nothing stops.
    await server.stop(true).catch(() => {});
    await gateway.stopAll().catch(() => {});
    await Bun.sleep(500);
    process.exit(0);
  });
}
