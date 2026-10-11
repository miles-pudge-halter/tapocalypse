import { describe, expect, test } from "bun:test";
import type { ComparePair, Transition } from "../web/lib/api";
import { addDismissed, collapsedGroups, groupPairs, linkTarget, readDismissed, suggestionKey, wordDiff } from "../web/lib/regression";

function pair(key: string, transition: Transition, extra: Partial<ComparePair> = {}): ComparePair {
  return {
    key,
    checkKey: `k:${key}`,
    transition,
    match: "title",
    confidence: "exact",
    flaky: false,
    lostCoverage: false,
    notReached: false,
    baseline: null,
    current: null,
    suggestion: null,
    ...extra,
  };
}

describe("groupPairs", () => {
  test("orders groups newly failing, flaky, fixed, changed, still failing, pending, new, removed, unchanged and drops empty ones", () => {
    const groups = groupPairs([
      pair("u1", "unchanged"),
      pair("n1", "new"),
      pair("f1", "fixed"),
      pair("x1", "newly_failing"),
      pair("x2", "newly_failing"),
      pair("s1", "still_failing"),
    ]);
    expect(groups.map((g) => g.transition)).toEqual(["newly_failing", "fixed", "still_failing", "new", "unchanged"]);
    expect(groups[0]?.pairs.map((p) => p.key)).toEqual(["x1", "x2"]);
  });

  test("keeps input order inside a group", () => {
    const groups = groupPairs([pair("b", "changed"), pair("a", "changed")]);
    expect(groups[0]?.pairs.map((p) => p.key)).toEqual(["b", "a"]);
  });
});

describe("collapsedGroups", () => {
  const pairs = [pair("x1", "newly_failing"), pair("u1", "unchanged"), pair("u2", "unchanged")];
  const groups = groupPairs(pairs);

  test("collapses Unchanged by default when other groups exist", () => {
    expect([...collapsedGroups(groups, { override: {} })]).toEqual(["unchanged"]);
  });

  test("never collapses the only group", () => {
    expect([...collapsedGroups(groupPairs([pair("u1", "unchanged")]), { override: {} })]).toEqual([]);
  });

  test("opens Unchanged when the show filter targets it", () => {
    expect(collapsedGroups(groups, { show: "unchanged", override: {} }).has("unchanged")).toBe(false);
  });

  test("opens Unchanged when the selected pair lives in it", () => {
    expect(collapsedGroups(groups, { selectedKey: "u2", override: {} }).has("unchanged")).toBe(false);
  });

  test("keeps Unchanged collapsed when the selected pair is elsewhere", () => {
    expect(collapsedGroups(groups, { selectedKey: "x1", override: {} }).has("unchanged")).toBe(true);
  });

  test("an explicit user toggle wins over the defaults in both directions", () => {
    expect(collapsedGroups(groups, { show: "unchanged", override: { unchanged: true } }).has("unchanged")).toBe(true);
    expect(collapsedGroups(groups, { override: { unchanged: false } }).has("unchanged")).toBe(false);
    expect(collapsedGroups(groups, { override: { newly_failing: true } }).has("newly_failing")).toBe(true);
  });
});

describe("wordDiff", () => {
  test("marks only the words that changed on each side", () => {
    const diff = wordDiff("Total shows 12 items", "Total shows 14 items");
    expect(diff.truncated).toBe(false);
    expect(diff.baseline.filter((t) => t.changed).map((t) => t.text)).toEqual(["12"]);
    expect(diff.current.filter((t) => t.changed).map((t) => t.text)).toEqual(["14"]);
  });

  test("an inserted word is marked only on the current side", () => {
    const diff = wordDiff("Cart is empty", "Cart is now empty");
    expect(diff.baseline.some((t) => t.changed)).toBe(false);
    expect(diff.current.filter((t) => t.changed).map((t) => t.text)).toEqual(["now"]);
  });

  test("identical notes have no changes", () => {
    const diff = wordDiff("same words here", "same words here");
    expect([...diff.baseline, ...diff.current].some((t) => t.changed)).toBe(false);
  });

  test("notes beyond 400 words are not highlighted", () => {
    const long = Array.from({ length: 401 }, (_, i) => `w${i}`).join(" ");
    const diff = wordDiff(long, `${long} extra`);
    expect(diff.truncated).toBe(true);
    expect([...diff.baseline, ...diff.current].some((t) => t.changed)).toBe(false);
  });
});

describe("linkTarget", () => {
  const side = (runId: string, checkId: string) => ({
    runId,
    checkId,
    title: checkId,
    status: "pass" as const,
    note: null,
    screenshotUrl: null,
    durationMs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  test("a new row with a suggestion links the baseline check named by the suggestion, from the run the suggestion names", () => {
    const added = pair("C3", "new", { current: side("run-new", "C3"), suggestion: { runId: "run-old2", checkId: "B2", title: "B2", similarity: 0.55 } });
    expect(linkTarget(added)).toEqual({
      a: { runId: "run-old2", checkId: "B2" },
      b: { runId: "run-new", checkId: "C3" },
    });
  });

  test("a removed row with a suggestion links the current-run check", () => {
    const removed = pair("b:run-old:B1", "removed", { baseline: side("run-old", "B1"), suggestion: { runId: "run-new", checkId: "C9", title: "C9", similarity: 0.52 } });
    expect(linkTarget(removed)).toEqual({
      a: { runId: "run-old", checkId: "B1" },
      b: { runId: "run-new", checkId: "C9" },
    });
  });

  test("a matched row links its own two sides (confirm an inferred match)", () => {
    const matched = pair("C1", "unchanged", { baseline: side("run-old", "B1"), current: side("run-new", "C1") });
    expect(linkTarget(matched)).toEqual({
      a: { runId: "run-old", checkId: "B1" },
      b: { runId: "run-new", checkId: "C1" },
    });
  });

  test("a row with neither a counterpart nor a suggestion has no link target", () => {
    const added = pair("C3", "new", { current: side("run-new", "C3") });
    expect(linkTarget(added)).toBeNull();
  });
});

describe("dismissed suggestions", () => {
  const side = (runId: string, checkId: string) => ({
    runId,
    checkId,
    title: checkId,
    status: "pass" as const,
    note: null,
    screenshotUrl: null,
    durationMs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  test("both rows of one suggested pair share a key, and another pair gets another key", () => {
    const added = pair("C3", "new", { current: side("run-new", "C3"), suggestion: { runId: "run-old", checkId: "B2", title: "B2", similarity: 0.55 } });
    const removed = pair("b:run-old:B2", "removed", { baseline: side("run-old", "B2"), suggestion: { runId: "run-new", checkId: "C3", title: "C3", similarity: 0.55 } });
    const other = pair("C4", "new", { current: side("run-new", "C4"), suggestion: { runId: "run-old", checkId: "B5", title: "B5", similarity: 0.55 } });
    expect(suggestionKey(added)).toBe(suggestionKey(removed));
    expect(suggestionKey(added)).not.toBe(suggestionKey(other));
  });

  test("a dismissal is remembered per project; garbage storage reads as nothing", () => {
    let raw = addDismissed(null, "proj-a", "k1");
    raw = addDismissed(raw, "proj-a", "k2");
    raw = addDismissed(raw, "proj-b", "k3");
    raw = addDismissed(raw, "proj-a", "k1");
    expect([...readDismissed(raw, "proj-a")].sort()).toEqual(["k1", "k2"]);
    expect([...readDismissed(raw, "proj-b")]).toEqual(["k3"]);
    expect(readDismissed(raw, "proj-c").size).toBe(0);
    expect(readDismissed("{not json", "proj-a").size).toBe(0);
    expect(readDismissed(null, "proj-a").size).toBe(0);
    expect([...readDismissed(addDismissed("[1,2]", "proj-a", "k9"), "proj-a")]).toEqual(["k9"]);
  });
});
