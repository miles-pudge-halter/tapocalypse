import { describe, expect, test } from "bun:test";
import { assignCheckKeys, assignTestKey, briefFingerprint, canonicalTitle, type KeyLookup, matchScore, runTitleFingerprint, titleKey } from "../src/regression/keys";
import { ACTIVE, type Check, type Run } from "../src/runs/types";

describe("canonicalTitle", () => {
  test("drops the agent id, case, accents, punctuation and filler words but keeps order and negations", () => {
    expect(canonicalTitle("B6.1 — Verify that the Café total is updated")).toBe("cafe total updated");
    expect(canonicalTitle("D2: Check no crash on launch")).toBe("no crash on launch");
    expect(canonicalTitle("W1 App is fine")).toBe("app fine");
    expect(canonicalTitle("a before b")).not.toBe(canonicalTitle("b before a"));
    expect(canonicalTitle("crash")).not.toBe(canonicalTitle("no crash"));
  });

  test("a title that is only an id-like word or filler falls back to the trimmed raw title; scripts without ASCII letters never collapse to empty", () => {
    expect(canonicalTitle("  Check that  ")).toBe("Check that");
    expect(canonicalTitle("支付总额更新")).not.toBe("");
    expect(canonicalTitle("支付总额更新")).not.toBe(canonicalTitle("登录成功"));
    expect(canonicalTitle("Проверить вход")).toBe("проверить вход");
  });
});

describe("fingerprints", () => {
  test("a brief fingerprint ignores the re-run section, case and whitespace but not the content", () => {
    const brief = "Open the cart.\nVerify the total.";
    const rerun = `${brief}\n\nRe-run ONLY these checks from run 20260101-000000-abcd-x (previous status + note):\n- C1 Total (fail: wrong)`;
    expect(briefFingerprint(rerun)).toBe(briefFingerprint(brief));
    expect(briefFingerprint("  OPEN the   cart.\n\nverify the total. ")).toBe(briefFingerprint(brief));
    expect(briefFingerprint("Open the cart. Verify the tax.")).not.toBe(briefFingerprint(brief));
    expect(briefFingerprint(brief)).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  test("a run-title fingerprint ignores versions, the re-run suffix and a round suffix, but keeps the lane", () => {
    const base = runTitleFingerprint("v2.3.054 release QA — lane a");
    expect(runTitleFingerprint("2.3.055 Release QA — Lane A (re-run)")).toBe(base);
    expect(runTitleFingerprint("v2.4 release QA — lane a-2")).toBe(base);
    expect(runTitleFingerprint("v2.3.054 release QA — lane b")).not.toBe(base);
  });
});

describe("titleKey", () => {
  test("is stable per project and canonical title, and a check id makes it unique", () => {
    expect(titleKey("p1", "cart total")).toBe(titleKey("p1", "cart total"));
    expect(titleKey("p1", "cart total")).not.toBe(titleKey("p2", "cart total"));
    expect(titleKey("p1", "cart total", "C2")).not.toBe(titleKey("p1", "cart total"));
    expect(titleKey("p1", "cart total")).toMatch(/^t:[A-Za-z0-9_-]{16}$/);
  });
});

describe("matchScore", () => {
  const score = (a: string, b: string, ids: [string, string] = ["C1", "C2"]) => matchScore({ id: ids[0], title: a }, { id: ids[1], title: b });

  test("is the Jaccard of the canonical tokens", () => {
    expect(score("alpha beta gamma delta", "alpha beta gamma epsilon")).toBeCloseTo(3 / 5, 10);
    expect(score("alpha", "omega")).toBe(0);
    expect(score("alpha beta", "alpha beta")).toBe(1);
  });

  test("a shared ticket key adds 0.25 and equal ids add 0.1", () => {
    expect(score("ACME-12 alpha beta gamma", "ACME-12 alpha beta delta")).toBeCloseTo(4 / 6 + 0.25, 10);
    expect(score("alpha beta gamma delta", "alpha beta gamma epsilon", ["W1", "W1"])).toBeCloseTo(0.6 + 0.1, 10);
    expect(score("ACME-12 alpha", "ACME-13 alpha")).toBeLessThan(1);
    expect(score("#7 alpha beta", "#7 alpha gamma")).toBeGreaterThan(score("#7 alpha beta", "#8 alpha gamma"));
  });

  test("two titles with no tokens do not score as identical", () => {
    expect(score("Check that", "Verify this")).toBe(0);
  });
});

// ---- identity over runs -------------------------------------------------------------------------------------------

let seq = 0;
function mkRun(over: Partial<Run> = {}): Run {
  const n = ++seq;
  return {
    id: `run-${n}`,
    projectId: "proj",
    title: `title ${n}`,
    brief: `brief ${n}`,
    requestedBy: "web",
    deviceRequest: { platform: "android" },
    deviceSerial: null,
    deviceName: null,
    bootedByRun: false,
    packageId: "com.example",
    status: "done",
    verdict: "PASS",
    summary: null,
    reportPath: null,
    checks: [],
    error: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    startedAt: null,
    endedAt: null,
    stats: null,
    transcriptHtml: false,
    source: null,
    build: null,
    batchId: null,
    suiteId: null,
    suiteChecks: null,
    harness: "omp",
    model: null,
    thinking: null,
    effort: null,
    errorKind: null,
    verdictSource: null,
    usage: null,
    attempt: 1,
    retryOf: null,
    retriedBy: null,
    rerunOf: null,
    install: null,
    storage: "data",
    gated: false,
    testKey: null,
    checkHints: null,
    reuseChecks: true,
    ...over,
  };
}

const check = (id: string, title: string, extra: Partial<Check> = {}): Check => ({ id, title, status: "pass", updatedAt: "2026-01-01T00:00:00.000Z", ...extra });

/** A lookup over a fixed set of runs; mirrors what regression/index.ts answers from the store. */
function lookupOver(runs: Run[]): KeyLookup {
  const keyed = runs.filter((r) => r.testKey !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const terminal = (r: Run) => !ACTIVE.includes(r.status);
  return {
    getRun: (id) => runs.find((r) => r.id === id) ?? null,
    earliestWithBrief: (projectId, fp) => keyed.find((r) => r.projectId === projectId && briefFingerprint(r.brief) === fp) ?? null,
    earliestWithTitle: (projectId, fp) => keyed.find((r) => r.projectId === projectId && runTitleFingerprint(r.title) === fp) ?? null,
    recentTestRuns: (projectId, testKey, before, limit) =>
      runs
        .filter((r) => r.projectId === projectId && r.testKey === testKey && terminal(r) && r.checks.length > 0 && r.createdAt < before)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    hasCheckKey: (projectId, key) => runs.some((r) => r.projectId === projectId && r.checks.some((c) => c.checkKey === key)),
  };
}

describe("assignTestKey", () => {
  test("a suite run is the suite's test", () => {
    expect(assignTestKey(mkRun({ suiteId: "checkout" }), lookupOver([]))).toBe("suite:checkout");
  });

  test("a rerun or a retry stays in its parent's test, whatever its own brief says", () => {
    const parent = mkRun({ testKey: "brief:parent" });
    const lookup = lookupOver([parent]);
    expect(assignTestKey(mkRun({ rerunOf: parent.id, brief: `${parent.brief}\n\nRe-run ONLY these checks from run ${parent.id} (previous status + note):\n- C1 x` }), lookup)).toBe("brief:parent");
    expect(assignTestKey(mkRun({ retryOf: parent.id }), lookup)).toBe("brief:parent");
  });

  test("the same brief joins the earliest run's test, then the same run title, otherwise a new test is born from the brief", () => {
    const first = mkRun({ brief: "Walk the cart", title: "Cart smoke v1.0", testKey: "brief:first" });
    const later = mkRun({ brief: "Walk the cart", title: "Other", testKey: "brief:later" });
    const lookup = lookupOver([later, first]);
    expect(assignTestKey(mkRun({ brief: "WALK the   cart" }), lookup)).toBe("brief:first");
    expect(assignTestKey(mkRun({ brief: "A rewritten brief", title: "Cart smoke v1.1 (re-run)" }), lookup)).toBe("brief:first");
    const fresh = mkRun({ brief: "Brand new brief", title: "Unrelated" });
    expect(assignTestKey(fresh, lookup)).toBe(`brief:${briefFingerprint("Brand new brief")}`);
  });

  test("another project's runs never lend their test", () => {
    const foreign = mkRun({ projectId: "elsewhere", brief: "Walk the cart", testKey: "brief:foreign" });
    expect(assignTestKey(mkRun({ brief: "Walk the cart" }), lookupOver([foreign]))).toBe(`brief:${briefFingerprint("Walk the cart")}`);
  });
});

const keyOf = (keys: ReturnType<typeof assignCheckKeys>, id: string) => keys.get(id)?.checkKey;

/** A finished run of `testKey` whose checks already carry their keys, as the store persists them. */
function keyedRun(testKey: string, checks: [string, string][], over: Partial<Run> = {}): Run {
  const run = mkRun({ testKey, ...over });
  run.checks = checks.map(([id, title]) => check(id, title, { checkKey: titleKey(run.projectId, canonicalTitle(title)), keyKind: "title" }));
  return run;
}

describe("assignCheckKeys: titles", () => {
  test("a new title is born with its title key, and another run's same title (other id, case, filler) meets it again", () => {
    const first = mkRun({ testKey: "t1", checks: [check("C1", "Cart total updates")] });
    const born = assignCheckKeys(first, lookupOver([]));
    expect(born.get("C1")).toEqual({ checkKey: titleKey("proj", "cart total updates"), keyKind: "title" });

    first.checks[0]!.checkKey = born.get("C1")!.checkKey;
    const second = mkRun({ testKey: "t1", checks: [check("W7", "verify that the CART TOTAL updates")] });
    expect(assignCheckKeys(second, lookupOver([first])).get("W7")).toEqual({ checkKey: born.get("C1")!.checkKey, keyKind: "title" });
  });

  test("the same title in another project is another check", () => {
    const a = assignCheckKeys(mkRun({ checks: [check("C1", "Cart total updates")] }), lookupOver([]));
    const b = assignCheckKeys(mkRun({ projectId: "other", checks: [check("C1", "Cart total updates")] }), lookupOver([]));
    expect(keyOf(a, "C1")).not.toBe(keyOf(b, "C1"));
  });
});

describe("assignCheckKeys: suite", () => {
  test("a suite check is keyed by suite and id, even when the title is known elsewhere; a check outside the suite is keyed by title", () => {
    const known = keyedRun("suite:checkout", [["C1", "Cart total updates"]]);
    const run = mkRun({
      suiteId: "checkout",
      suiteChecks: [{ id: "C1", title: "Cart total updates" }],
      testKey: "suite:checkout",
      checks: [check("C1", "Cart total updates"), check("X9", "Extra thing")],
    });
    const keys = assignCheckKeys(run, lookupOver([known]));
    expect(keys.get("C1")).toEqual({ checkKey: "s:checkout:C1", keyKind: "suite" });
    expect(keys.get("X9")?.keyKind).toBe("title");
  });
});

describe("assignCheckKeys: lineage", () => {
  test("a re-run's check takes the key of the parent's check with the same id, even when the title was reworded", () => {
    const parent = keyedRun("t1", [["W5", "Login works"]]);
    const rerun = mkRun({ testKey: "t1", rerunOf: parent.id, checks: [check("W5", "Completely different words")] });
    expect(assignCheckKeys(rerun, lookupOver([parent])).get("W5")).toEqual({ checkKey: parent.checks[0]!.checkKey!, keyKind: "lineage" });
  });

  test("a retry looks at the attempt it retries, then at the run it re-runs; ids the parents lack fall through to the title", () => {
    const original = keyedRun("t1", [["W5", "Login works"]]);
    const attempt = mkRun({ testKey: "t1", rerunOf: original.id, status: "error", checks: [] });
    const retry = mkRun({ testKey: "t1", retryOf: attempt.id, rerunOf: original.id, checks: [check("W5", "Login works!"), check("W6", "Brand new")] });
    const keys = assignCheckKeys(retry, lookupOver([original, attempt]));
    expect(keys.get("W5")).toEqual({ checkKey: original.checks[0]!.checkKey!, keyKind: "lineage" });
    expect(keys.get("W6")?.keyKind).toBe("title");
  });
});

describe("assignCheckKeys: carried (`was`)", () => {
  const hinted = (checks: Check[]): Run =>
    mkRun({
      testKey: "t1",
      checkHints: {
        fromRunIds: ["earlier"],
        checks: [
          { id: "W1", title: "Old wording one", checkKey: "t:hint-one" },
          { id: "W2", title: "Old wording two", checkKey: "t:hint-two" },
        ],
      },
      checks,
    });

  test("`was` naming a hint takes that hint's key, ahead of the title and of an inferred match", () => {
    const run = hinted([check("C1", "Totally new words", { was: "W2" })]);
    expect(assignCheckKeys(run, lookupOver([])).get("C1")).toEqual({ checkKey: "t:hint-two", keyKind: "carried" });
  });

  test("`was` naming an id that was not hinted is ignored", () => {
    const run = hinted([check("C1", "Totally new words", { was: "W9" })]);
    expect(assignCheckKeys(run, lookupOver([])).get("C1")?.keyKind).toBe("title");
  });

  test("the first claim of a hint wins; the second check falls through to its title", () => {
    const run = hinted([check("C1", "First claimant", { was: "W1" }), check("C2", "Second claimant", { was: "W1" })]);
    const keys = assignCheckKeys(run, lookupOver([]));
    expect(keys.get("C1")).toEqual({ checkKey: "t:hint-one", keyKind: "carried" });
    expect(keys.get("C2")?.keyKind).toBe("title");
    expect(keys.get("C2")?.checkKey).not.toBe("t:hint-one");
  });

  test("a hint whose key an earlier check of the run already holds (suite, lineage) is not claimed twice", () => {
    const parent = keyedRun("t1", [["C1", "Old wording one"]]);
    parent.checks[0]!.checkKey = "t:hint-one";
    const run = hinted([check("C1", "Same id as parent"), check("C2", "Claims it too", { was: "W1" })]);
    run.rerunOf = parent.id;
    const keys = assignCheckKeys(run, lookupOver([parent]));
    expect(keys.get("C1")).toEqual({ checkKey: "t:hint-one", keyKind: "lineage" });
    expect(keys.get("C2")?.keyKind).toBe("title");
  });
});

describe("assignCheckKeys: inferred", () => {
  const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

  test("a title scoring 0.6 against a check of the same test's earlier run adopts its key and records the score", () => {
    const earlier = keyedRun("t1", [["C1", "alpha beta gamma delta"]]);
    const run = mkRun({ testKey: "t1", checks: [check("X1", "alpha beta gamma epsilon")] });
    const got = assignCheckKeys(run, lookupOver([earlier])).get("X1")!;
    expect(got.checkKey).toBe(earlier.checks[0]!.checkKey!);
    expect(got.keyKind).toBe("inferred");
    expect(got.keyScore).toBeCloseTo(0.6, 10);
  });

  test("0.588 is not enough: the check is born with its own title key", () => {
    const earlier = keyedRun("t1", [["C1", `${words("s", 10)} ${words("a", 3)}`]]);
    const title = `${words("s", 10)} ${words("b", 4)}`;
    expect(matchScore({ id: "X1", title }, { id: "C1", title: earlier.checks[0]!.title })).toBeCloseTo(10 / 17, 10);
    const got = assignCheckKeys(mkRun({ testKey: "t1", checks: [check("X1", title)] }), lookupOver([earlier])).get("X1")!;
    expect(got).toEqual({ checkKey: titleKey("proj", canonicalTitle(title)), keyKind: "title" });
  });

  test("a shared ticket key or id can lift a title over the threshold", () => {
    const earlier = keyedRun("t1", [["W1", "ACME-12 alpha beta gamma delta epsilon"]]);
    const run = mkRun({ testKey: "t1", checks: [check("W1", "ACME-12 alpha beta zeta eta theta")] });
    expect(assignCheckKeys(run, lookupOver([earlier])).get("W1")?.keyKind).toBe("inferred");
  });

  test("only runs of the same test count", () => {
    const elsewhere = keyedRun("t-other", [["C1", "alpha beta gamma delta"]]);
    const run = mkRun({ testKey: "t1", checks: [check("X1", "alpha beta gamma epsilon")] });
    expect(assignCheckKeys(run, lookupOver([elsewhere])).get("X1")?.keyKind).toBe("title");
    const unkeyed = mkRun({ testKey: null, checks: [check("X1", "alpha beta gamma epsilon")] });
    expect(assignCheckKeys(unkeyed, lookupOver([keyedRun("t1", [["C1", "alpha beta gamma delta"]])])).get("X1")?.keyKind).toBe("title");
  });

  test("only the last 3 runs of the test are searched, newest first on equal scores", () => {
    const oldest = keyedRun("t1", [["C1", "alpha beta gamma delta"]]);
    const filler = [1, 2, 3].map((i) => keyedRun("t1", [["C1", `unrelated ${i} words here`]]));
    const run = mkRun({ testKey: "t1", checks: [check("X1", "alpha beta gamma epsilon")] });
    expect(assignCheckKeys(run, lookupOver([oldest, ...filler])).get("X1")?.keyKind).toBe("title");
    expect(assignCheckKeys(run, lookupOver([oldest, ...filler.slice(0, 2)])).get("X1")?.keyKind).toBe("inferred");

    const older = keyedRun("t1", [["C1", "alpha beta gamma delta"]]);
    const newer = keyedRun("t1", [["C1", "alpha beta gamma zeta"]]);
    const later = mkRun({ testKey: "t1", checks: [check("X1", "alpha beta gamma epsilon")] });
    expect(assignCheckKeys(later, lookupOver([older, newer])).get("X1")?.checkKey).toBe(newer.checks[0]!.checkKey!);
  });

  test("an exact title the project already knows is a title match, not an inference", () => {
    const earlier = keyedRun("t1", [["C1", "alpha beta gamma delta"], ["C2", "alpha beta gamma delta epsilon"]]);
    const run = mkRun({ testKey: "t1", checks: [check("X1", "alpha beta gamma delta epsilon")] });
    expect(assignCheckKeys(run, lookupOver([earlier])).get("X1")).toEqual({ checkKey: earlier.checks[1]!.checkKey!, keyKind: "title" });
  });

  test("a previous check is adopted by one new check only", () => {
    const earlier = keyedRun("t1", [["C1", "alpha beta gamma delta"]]);
    const run = mkRun({ testKey: "t1", checks: [check("X1", "alpha beta gamma epsilon"), check("X2", "alpha beta gamma zeta")] });
    const keys = assignCheckKeys(run, lookupOver([earlier]));
    expect(keys.get("X1")?.keyKind).toBe("inferred");
    expect(keys.get("X2")?.keyKind).toBe("title");
  });
});

describe("assignCheckKeys: one key per run", () => {
  test("two checks with the same canonical title get different keys, and a re-run of the plan is stable", () => {
    const run = mkRun({ testKey: "t1", checks: [check("C1", "Cart total updates"), check("C2", "verify the cart total updates")] });
    const keys = assignCheckKeys(run, lookupOver([]));
    expect(keys.get("C1")?.checkKey).toBe(titleKey("proj", "cart total updates"));
    expect(keys.get("C2")?.checkKey).toBe(titleKey("proj", "cart total updates", "C2"));
    expect(assignCheckKeys(run, lookupOver([]))).toEqual(keys);
  });

  test("a check that already has a key keeps it, reserves it, and is not reassigned", () => {
    const run = mkRun({
      testKey: "t1",
      checks: [check("C1", "Cart total updates", { checkKey: titleKey("proj", "cart total updates"), keyKind: "manual" }), check("C2", "Cart total updates")],
    });
    const keys = assignCheckKeys(run, lookupOver([]));
    expect(keys.has("C1")).toBe(false);
    expect(keys.get("C2")?.checkKey).toBe(titleKey("proj", "cart total updates", "C2"));
  });

  test("a repeated check id yields one key", () => {
    const run = mkRun({ checks: [check("C1", "First"), check("C1", "Second")] });
    expect(assignCheckKeys(run, lookupOver([])).size).toBe(1);
  });

  test("titles in scripts without ASCII letters get distinct keys", () => {
    const run = mkRun({ checks: [check("C1", "支付总额更新"), check("C2", "登录成功")] });
    const keys = assignCheckKeys(run, lookupOver([]));
    expect(keyOf(keys, "C1")).not.toBe(keyOf(keys, "C2"));
  });
});
