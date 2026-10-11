import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/config";
import { backfill, checkEntries, hintsFor, keyLookup, keysOf, projectGeneration, projectKeys, relink, runsOfTest, unlink } from "../src/regression/index";
import { createRun, deleteRun, getRun, type NewRun, saveRun } from "../src/runs/store";
import type { Check, Run } from "../src/runs/types";

let counter = 0;
const uniq = (label: string) => `${label}-${Date.now().toString(36)}-${++counter}`;

function check(id: string, title: string, extra: Partial<Check> = {}): Check {
  return { id, title, status: "pass", updatedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

function fields(projectId: string, over: Partial<NewRun> = {}): NewRun {
  return {
    projectId,
    title: "t",
    brief: uniq("brief"),
    requestedBy: "web",
    deviceRequest: { platform: "android" },
    deviceSerial: null,
    bootedByRun: false,
    packageId: "com.example",
    status: "done",
    verdict: "PASS",
    summary: null,
    reportPath: null,
    checks: [],
    error: null,
    startedAt: null,
    endedAt: null,
    stats: null,
    transcriptHtml: false,
    storage: "data",
    ...over,
  };
}

/** Creates a run and stamps its creation time so ordering is deterministic. */
function make(projectId: string, minute: number, over: Partial<NewRun> = {}): Run {
  const run = createRun(fields(projectId, over));
  run.createdAt = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  saveRun(run);
  return run;
}

const keyed = (id: string, title: string, key: string, status: Check["status"] = "pass"): Check => check(id, title, { checkKey: key, keyKind: "title", status });

describe("derived maps", () => {
  test("runsOfTest lists a test's terminal runs newest first and follows saves and deletes", () => {
    const p = uniq("proj");
    const a = make(p, 1, { testKey: "t1" });
    const b = make(p, 3, { testKey: "t1" });
    const live = make(p, 4, { testKey: "t1", status: "running" });
    make(p, 2, { testKey: "t2" });
    make("other-project", 5, { testKey: "t1" });
    expect(runsOfTest(p, "t1").map((r) => r.id)).toEqual([b.id, a.id]);

    live.status = "done";
    saveRun(live);
    expect(runsOfTest(p, "t1").map((r) => r.id)).toEqual([live.id, b.id, a.id]);

    deleteRun(b.id);
    expect(runsOfTest(p, "t1").map((r) => r.id)).toEqual([live.id, a.id]);
  });

  test("checkEntries lists a key's checks newest first, and a re-key moves the entry", () => {
    const p = uniq("proj");
    const a = make(p, 1, { testKey: "t1", checks: [keyed("C1", "Login", "k:login")] });
    const b = make(p, 2, { testKey: "t1", checks: [keyed("W3", "Log in", "k:login"), keyed("W4", "Cart", "k:cart")] });
    expect(checkEntries(p, "k:login").map((e) => [e.run.id, e.check.id])).toEqual([[b.id, "W3"], [a.id, "C1"]]);
    expect(checkEntries(p, "k:none")).toEqual([]);
    expect(checkEntries("other-project", "k:login")).toEqual([]);

    const moved = getRun(b.id)!;
    moved.checks[0]!.checkKey = "k:signin";
    saveRun(moved);
    expect(checkEntries(p, "k:login").map((e) => e.run.id)).toEqual([a.id]);
    expect(checkEntries(p, "k:signin").map((e) => e.run.id)).toEqual([b.id]);
  });

  test("projectKeys counts the runs each key appears in; unkeyed checks and active runs do not count", () => {
    const p = uniq("proj");
    make(p, 1, { testKey: "t1", checks: [keyed("C1", "Login", "k:login")] });
    make(p, 2, { testKey: "t1", checks: [keyed("C1", "Login", "k:login"), keyed("C2", "Cart", "k:cart"), check("C3", "No key yet")] });
    make(p, 3, { testKey: "t1", status: "running", checks: [keyed("C1", "Login", "k:login")] });
    const keys = projectKeys(p);
    expect(keys.find((k) => k.checkKey === "k:login")?.runs).toBe(2);
    expect(keys.find((k) => k.checkKey === "k:cart")?.runs).toBe(1);
    expect(keys).toHaveLength(2);
  });

  test("projectGeneration changes when a finished run of that project is saved or deleted, not for other projects or live runs", () => {
    const p = uniq("proj");
    const other = uniq("proj");
    const before = projectGeneration(p);
    const live = make(p, 1, { testKey: "t1", status: "running" });
    make(other, 2, { testKey: "t1" });
    live.checks = [check("C1", "Login")];
    saveRun(live);
    expect(projectGeneration(p)).toBe(before);

    live.status = "done";
    saveRun(live);
    const afterFinish = projectGeneration(p);
    expect(afterFinish).toBeGreaterThan(before);
    const otherBefore = projectGeneration(other);
    const r = make(p, 3, { testKey: "t1" });
    expect(projectGeneration(p)).toBeGreaterThan(afterFinish);
    expect(projectGeneration(other)).toBe(otherBefore);
    const afterSave = projectGeneration(p);
    deleteRun(r.id);
    expect(projectGeneration(p)).toBeGreaterThan(afterSave);
  });
});

describe("keysOf", () => {
  test("a terminal run reports its persisted keys; a live run's keys are computed on the fly without being persisted", () => {
    const p = uniq("proj");
    const done = make(p, 1, { testKey: "t1", checks: [keyed("C1", "Login works", "k:persisted")] });
    expect(keysOf(done).get("C1")).toEqual({ checkKey: "k:persisted", keyKind: "title" });

    const live = make(p, 2, { testKey: "t1", status: "running", checks: [check("C1", "Something else entirely")] });
    const computed = keysOf(live).get("C1")!;
    expect(computed.checkKey).toMatch(/^t:/);
    expect(getRun(live.id)!.checks[0]!.checkKey).toBeUndefined();
  });
});

describe("backfill", () => {
  const oldRun = (p: string, minute: number, over: Partial<NewRun> = {}): Run => {
    // A run persisted before regression intelligence: no testKey, no check keys.
    const run = make(p, minute, over);
    run.testKey = null;
    saveRun(run);
    return run;
  };

  test("keys runs oldest first, so a later run meets the earlier one's keys, and a second pass changes nothing", async () => {
    const p = uniq("proj");
    const brief = uniq("same brief");
    const later = oldRun(p, 2, { brief, checks: [check("W9", "alpha beta gamma epsilon")] });
    const first = oldRun(p, 1, { brief, checks: [check("C1", "alpha beta gamma delta")] });
    const running = oldRun(p, 3, { brief, status: "running", checks: [check("C1", "Cart total updates")] });

    const result = await backfill();
    expect(result.keyed).toBeGreaterThanOrEqual(3);

    const a = getRun(first.id)!;
    const b = getRun(later.id)!;
    expect(a.testKey).not.toBeNull();
    expect(b.testKey).toBe(a.testKey);
    expect(b.checks[0]!.checkKey).toBe(a.checks[0]!.checkKey!);
    expect(b.checks[0]!.keyKind).toBe("inferred");
    const live = getRun(running.id)!;
    expect(live.testKey).toBe(a.testKey);
    expect(live.checks[0]!.checkKey).toBeUndefined();

    const snapshot = JSON.stringify([a, b, live]);
    expect((await backfill()).keyed).toBe(0);
    expect(JSON.stringify([getRun(first.id), getRun(later.id), getRun(running.id)])).toBe(snapshot);
  });

  test("a damaged run (no brief) is skipped, and the runs after it are still keyed", async () => {
    const p = uniq("proj");
    const damaged = oldRun(p, 1, { checks: [check("C1", "Login")] });
    const fine = oldRun(p, 2, { checks: [check("C1", "Cart total updates")] });
    saveRun({ ...getRun(damaged.id)!, brief: undefined as unknown as string });
    await backfill();
    expect(getRun(fine.id)!.testKey).not.toBeNull();
    expect(getRun(fine.id)!.checks[0]!.checkKey).toBeDefined();
  });
});

describe("hintsFor", () => {
  const probe = (p: string, over: Partial<Parameters<typeof hintsFor>[0]> = {}): Parameters<typeof hintsFor>[0] => ({
    projectId: p,
    testKey: "t1",
    suiteId: null,
    retryOf: null,
    rerunOf: null,
    deviceRequest: { platform: "android" },
    ...over,
  });

  test("a fresh run is shown the checks of the last 2 runs of its test, newest first, deduped by key, without statuses", () => {
    const p = uniq("proj");
    make(p, 1, { testKey: "t1", checks: [keyed("C1", "Oldest only", "k:oldest")] });
    make(p, 2, { testKey: "t1", checks: [keyed("C1", "Login", "k:login"), keyed("C2", "Cart", "k:cart")] });
    const newest = make(p, 3, { testKey: "t1", checks: [keyed("C1", "Log in", "k:login"), keyed("C3", "Pay", "k:pay", "fail")] });
    const hints = hintsFor(probe(p), {})!;
    expect(hints.fromRunIds).toEqual([newest.id, runsOfTest(p, "t1")[1]!.id]);
    // The newer run wins the id clash on C1; C1 of the older run is the same key anyway.
    expect(hints.checks).toEqual([
      { id: "C1", title: "Log in", checkKey: "k:login" },
      { id: "C3", title: "Pay", checkKey: "k:pay" },
      { id: "C2", title: "Cart", checkKey: "k:cart" },
    ]);
    expect(JSON.stringify(hints)).not.toContain("fail");
  });

  test("the same platform is preferred, any platform is the fallback, and a long title is cut", () => {
    const p = uniq("proj");
    const long = "x".repeat(300);
    const ios = make(p, 1, { testKey: "t1", deviceRequest: { platform: "ios" }, checks: [keyed("C1", long, "k:long")] });
    const android = make(p, 2, { testKey: "t1", checks: [keyed("C1", "Android only", "k:a")] });
    make(p, 3, { testKey: "t1", deviceRequest: { platform: "ios" }, status: "error", checks: [] });
    expect(hintsFor(probe(p), {})!.fromRunIds).toEqual([android.id]);
    const iosHints = hintsFor(probe(p, { deviceRequest: { platform: "ios" } }), {})!;
    expect(iosHints.fromRunIds).toEqual([ios.id]);
    expect(iosHints.checks[0]!.title.length).toBe(160);
    const fallback = uniq("proj");
    const only = make(fallback, 1, { testKey: "t1", checks: [keyed("C1", "A", "k:a")] });
    expect(hintsFor(probe(fallback, { deviceRequest: { platform: "ios" } }), {})!.fromRunIds).toEqual([only.id]);
  });

  test("suite runs, re-runs of failed checks and first runs of a test get no hints", () => {
    const p = uniq("proj");
    const earlier = make(p, 1, { testKey: "t1", checks: [keyed("C1", "Login", "k:login")] });
    expect(hintsFor(probe(p, { suiteId: "s" }), {})).toBeNull();
    expect(hintsFor(probe(p, { rerunOf: earlier.id }), {})).toBeNull();
    expect(hintsFor(probe(uniq("fresh")), {})).toBeNull();
    expect(hintsFor(probe(p, { testKey: null }), {})).toBeNull();
  });

  test("a re-run of everything or a retry is shown its parent's checks; a parent that never planned passes its own hints on", () => {
    const p = uniq("proj");
    make(p, 1, { testKey: "t1", checks: [keyed("C1", "Elsewhere", "k:else")] });
    const parent = make(p, 2, { testKey: "t1", checks: [keyed("W1", "Login", "k:login")] });
    const got = hintsFor(probe(p, { rerunOf: parent.id }), { parent })!;
    expect(got).toEqual({ fromRunIds: [parent.id], checks: [{ id: "W1", title: "Login", checkKey: "k:login" }] });

    const hints = { fromRunIds: ["x"], checks: [{ id: "H1", title: "Shown before", checkKey: "k:h" }] };
    const crashed = make(p, 3, { testKey: "t1", status: "error", checks: [], checkHints: hints });
    expect(hintsFor(probe(p, { retryOf: crashed.id }), { parent: crashed })).toEqual(hints);
  });
});

describe("relink / unlink", () => {
  test("relink re-keys every check of the project that carries the newer check's key, as manual, and leaves other keys alone", () => {
    const p = uniq("proj");
    const older = make(p, 1, { testKey: "t1", checks: [keyed("C1", "Sign in", "k:old")] });
    const mid = make(p, 2, { testKey: "t1", checks: [keyed("C1", "Log in screen", "k:new", "fail"), keyed("C2", "Cart", "k:cart")] });
    const newer = make(p, 3, { testKey: "t1", checks: [keyed("W4", "Login screen", "k:new")] });
    make(uniq("other"), 4, { testKey: "t1", checks: [keyed("C1", "Elsewhere", "k:new")] });

    relink(p, { runId: older.id, checkId: "C1" }, { runId: newer.id, checkId: "W4" });

    for (const [run, i] of [[mid, 0], [newer, 0]] as const) {
      expect(getRun(run.id)!.checks[i]).toMatchObject({ checkKey: "k:old", keyKind: "manual" });
    }
    expect(getRun(mid.id)!.checks[1]!.checkKey).toBe("k:cart");
    expect(getRun(older.id)!.checks[0]).toMatchObject({ checkKey: "k:old", keyKind: "title" });
    expect(checkEntries(p, "k:old").map((e) => e.run.id)).toEqual([newer.id, mid.id, older.id]);
    expect(checkEntries(p, "k:new")).toEqual([]);
  });

  test("relink refuses unknown runs and checks (404), another project's run (400) and an active run (409), and changes nothing", () => {
    const p = uniq("proj");
    const a = make(p, 1, { testKey: "t1", checks: [keyed("C1", "A", "k:a")] });
    const b = make(p, 2, { testKey: "t1", checks: [keyed("C1", "B", "k:b")] });
    const foreign = make(uniq("other"), 3, { testKey: "t1", checks: [keyed("C1", "F", "k:f")] });
    const live = make(p, 4, { testKey: "t1", status: "running", checks: [check("C1", "L")] });
    const ref = (r: Run, checkId = "C1") => ({ runId: r.id, checkId });
    const status = (fn: () => void): number | null => {
      try {
        fn();
        return null;
      } catch (e) {
        return e instanceof HttpError ? e.status : -1;
      }
    };
    expect(status(() => relink(p, ref(a), { runId: "no-such-run", checkId: "C1" }))).toBe(404);
    expect(status(() => relink(p, ref(a), ref(b, "ZZ")))).toBe(404);
    expect(status(() => relink(p, ref(a), ref(foreign)))).toBe(400);
    expect(status(() => relink(p, ref(a), ref(live)))).toBe(409);
    expect(getRun(b.id)!.checks[0]!.checkKey).toBe("k:b");
    expect(status(() => relink(p, ref(a), ref(a)))).toBe(400);
  });

  test("relink refuses a link inside one run and a link that would put two checks of one run on the same key, and changes nothing", () => {
    const p = uniq("proj");
    const a = make(p, 1, { testKey: "t1", checks: [keyed("X", "Sign in", "k:x"), keyed("Y", "Cart", "k:y")] });
    const q = make(p, 2, { testKey: "t1", checks: [keyed("Z", "Sign in screen", "k:x"), keyed("W", "Pay", "k:w", "fail")] });
    const status = (fn: () => void): number | null => {
      try {
        fn();
        return null;
      } catch (e) {
        return e instanceof HttpError ? e.status : -1;
      }
    };
    // Two different checks of one run.
    expect(status(() => relink(p, { runId: a.id, checkId: "X" }, { runId: a.id, checkId: "Y" }))).toBe(400);
    // Q already holds k:x on Z; W would take k:x as well.
    expect(status(() => relink(p, { runId: a.id, checkId: "X" }, { runId: q.id, checkId: "W" }))).toBe(400);
    expect(getRun(q.id)!.checks.map((c) => c.checkKey)).toEqual(["k:x", "k:w"]);
    expect(checkEntries(p, "k:w").map((e) => e.run.id)).toEqual([q.id]);
  });

  test("confirming an inferred match (equal keys) makes the link manual on both checks", () => {
    const p = uniq("proj");
    const a = make(p, 1, { testKey: "t1", checks: [check("C1", "Sign in", { checkKey: "k:s", keyKind: "title" })] });
    const b = make(p, 2, { testKey: "t1", checks: [check("W1", "Log in", { checkKey: "k:s", keyKind: "inferred", keyScore: 0.7 })] });
    relink(p, { runId: a.id, checkId: "C1" }, { runId: b.id, checkId: "W1" });
    expect(getRun(a.id)!.checks[0]).toMatchObject({ checkKey: "k:s", keyKind: "manual" });
    expect(getRun(b.id)!.checks[0]).toMatchObject({ checkKey: "k:s", keyKind: "manual" });
    expect(getRun(b.id)!.checks[0]!.keyScore).toBeUndefined();
    expect(checkEntries(p, "k:s").map((e) => e.run.id)).toEqual([b.id, a.id]);
  });

  test("unlink refuses a run of another project", () => {
    const p = uniq("proj");
    const r = make(p, 1, { testKey: "t1", checks: [keyed("C1", "Same", "k:shared")] });
    expect(() => unlink(uniq("other"), r.id, "C1")).toThrow(HttpError);
    expect(getRun(r.id)!.checks[0]!.checkKey).toBe("k:shared");
  });

  test("relink of an unkeyed terminal run keys it first", () => {
    const p = uniq("proj");
    const a = make(p, 1, { testKey: "t1", checks: [keyed("C1", "A", "k:a")] });
    const b = make(p, 2, { testKey: "t1", checks: [check("C1", "Totally different")] });
    relink(p, { runId: a.id, checkId: "C1" }, { runId: b.id, checkId: "C1" });
    expect(getRun(b.id)!.checks[0]).toMatchObject({ checkKey: "k:a", keyKind: "manual" });
  });

  test("unlink gives the check a key of its own, repeatably, and others keep theirs", () => {
    const p = uniq("proj");
    const a = make(p, 1, { testKey: "t1", checks: [keyed("C1", "Same", "k:shared")] });
    const b = make(p, 2, { testKey: "t1", checks: [keyed("C1", "Same", "k:shared")] });
    unlink(p, b.id, "C1");
    const own = getRun(b.id)!.checks[0]!;
    expect(own.keyKind).toBe("manual");
    expect(own.checkKey).toMatch(/^u:/);
    expect(getRun(a.id)!.checks[0]!.checkKey).toBe("k:shared");
    expect(checkEntries(p, "k:shared").map((e) => e.run.id)).toEqual([a.id]);
    unlink(p, b.id, "C1");
    expect(getRun(b.id)!.checks[0]!.checkKey).toBe(own.checkKey!);
    expect(() => unlink(p, b.id, "ZZ")).toThrow(HttpError);
    expect(() => unlink(p, "no-such-run", "C1")).toThrow(HttpError);
  });
});

describe("damaged runs", () => {
  test("a stored run without a brief is left out of the maps instead of breaking every lookup", () => {
    const p = uniq("proj");
    const good = make(p, 1, { testKey: "t1", checks: [keyed("C1", "Login", "k:login")] });
    const damaged = make(p, 2, { testKey: "t1", checks: [keyed("C1", "Login", "k:login")] });
    saveRun({ ...damaged, brief: undefined as unknown as string });
    expect(runsOfTest(p, "t1").map((r) => r.id)).toEqual([good.id]);
    expect(keyLookup.earliestWithBrief(p, "anything")).toBeNull();
  });
});
