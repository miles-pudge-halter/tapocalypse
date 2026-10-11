# Demo data

`bun run demo [--dir <dataDir>] [--config <file>] [--repo <dir>]` is a maintainer tool that seeds a throwaway Tapocalypse instance with a fictional project, **Acme Shop** (`com.acme.shop.dev`): about 30 finished runs from the last four days across the omp, Claude Code and Codex harnesses (passes, issues, failures, a blocked run, an infra error with its retry, a cancelled run, a derived verdict and a two-device batch), with each run's report (`report.md`) and evidence screenshots (`screenshots/`) stored in its run folder inside the data dir, the way real runs are, over a temporary git repo that holds no artefacts of those runs (`screens/` holds the five fictional app screens used as evidence). The two oldest runs are seeded as legacy runs (`storage: "repo"`) with their report and screenshots under the temp repo's `qa/`, so the legacy read path stays exercised. It is what the README screenshots are taken from. Without `--dir` it writes to a fresh temp directory and never touches your real config or data dir; it refuses to write into a data dir that already has runs. It prints the command to serve the result, for example `TAPOCALYPSE_PORT=4320 TAPOCALYPSE_CONFIG=<config> TAPOCALYPSE_DATA_DIR=<dir> NODE_ENV=production bun src/server.ts`. The Devices page and the New run sheet read real connected devices, so for screenshots the seed script also exports `DEMO_DEVICES` (a Pixel 8 emulator and an iPhone 16 simulator with made-up ids) to stub `/api/devices` in the browser.

## Regression story

Eight of the runs exist to show regression intelligence (check history, the automatic baseline, flaky checks). Two recurring tests, **Checkout smoke** and **Dark mode survives restart**, have runs on `main` and on the PR branch `feat/cart-badge` (PR #142, base `main`). The runs carry no `testKey` or `checkKey`: the server's boot backfill assigns them, exactly as it does for runs recorded before the feature, so screenshots show what an upgraded install shows.

| What | Where |
|---|---|
| Newly failing | "Checkout reaches the order summary" passes on `main` and fails on the PR run |
| Fixed | "Add to cart updates the cart" fails on the newest `main` runs and passes on the PR run |
| Flaky | "Quantity change recalculates totals" passes, fails, passes on the same clean `main` commit and the same Pixel 8 (the PR run's failure of it shows as flaky, not as a regression) |
| Device-sensitive | "Catalog loads with four products" passes on the Pixel 8 and fails on a Pixel 6a at the same `main` commit |
| Inferred match | the PR run words one check differently ("Product page opens from the catalog" for "Product detail opens from the catalog"); it is matched by title similarity, not by an exact title |
| Rerun lineage | a "Checkout smoke (re-run)" re-tests the two failed checks of the PR run and keeps their ids |
| History | "Checkout smoke" also has older runs on an earlier `main` commit and on a release branch; "Dark mode survives restart" has two `main` runs, a PR run with a failing check and a later PR run, on a review-fix commit, where it passes |
