// Run as a child process (fresh module state, so the regression index builds from the store on its first query):
// prints the index answers for runs written before the first query, then again after re-saving every run newest
// first, which is how the incremental path (and the original build) orders its inserts.
import { checkEntries, runsOfTest } from "../../src/regression/index";
import { createRun, listRuns, saveRun } from "../../src/runs/store";
import type { Run } from "../../src/runs/types";

const PROJECT = "order-proj";
const minutes = [5, 1, 3, 3, 2, 3, 4, 1]; // out of order, with ties
for (const [i, minute] of minutes.entries()) {
  const run = createRun({
    projectId: PROJECT, title: `t${i}`, brief: `brief ${i}`, requestedBy: "web", deviceRequest: { platform: "android" },
    deviceSerial: null, bootedByRun: false, packageId: "com.example", status: "done", verdict: "PASS", summary: null,
    reportPath: null, checks: [{ id: "C1", title: "Login", status: "pass", updatedAt: "2026-01-01T00:00:00.000Z", checkKey: "k:login", keyKind: "title" }],
    error: null, startedAt: null, endedAt: null, stats: null, transcriptHtml: false, storage: "data", testKey: "t1",
  });
  run.createdAt = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  saveRun(run);
}
const answer = () => ({
  tests: runsOfTest(PROJECT, "t1").map((r: Run) => r.title),
  checks: checkEntries(PROJECT, "k:login").map((e) => e.run.title),
});
const built = answer();
for (const run of listRuns({ projectId: PROJECT })) saveRun(run);
console.log(JSON.stringify({ built, incremental: answer() }));
