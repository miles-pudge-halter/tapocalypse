import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LivePendingState, LiveStatus, RunningNow } from "../web/components/hub/live-status";
import { ActiveCard } from "../web/components/run/active-card";
import { DevicePane } from "../web/components/run/device-pane";
import { Timeline } from "../web/components/run/timeline";
import { TooltipProvider } from "../web/components/ui/tooltip";
import type { Check, RunView } from "../web/lib/api";
import { LIVE_PENDING_COPY, LIVE_STALE_MS, checkProgress, isLiveRun, liveState } from "../web/lib/live";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

function check(id: string, status: Check["status"]): Check {
  return { id, title: `Check ${id}`, status, updatedAt: iso(5000) };
}

function run(over: Partial<RunView> = {}, live: { agoMs: number } | null = { agoMs: 10_000 }): RunView {
  const base: RunView = {
    id: "run-live-1",
    projectId: "shop",
    title: "Checkout total updates",
    status: "running",
    verdict: null,
    createdAt: iso(120_000),
    startedAt: iso(100_000),
    endedAt: null,
    checks: [check("C1", "pass"), check("C2", "fail"), check("C3", "running"), check("C4", "pending")],
    deviceSerial: null,
    deviceRequest: { platform: "android", serial: null },
    requestedBy: "mcp",
    queuePosition: null,
    durationMs: null,
    queueReason: null,
    reportFile: null,
    runDir: "",
    hub: {
      machine: "ann-mbp",
      uploader: "ann.lee@acme.dev",
      receivedAt: iso(10_000),
      localProjectId: "local-shop",
      ...(live ? { live: { lastSeenAt: iso(live.agoMs) } } : {}),
    },
  } as unknown as RunView;
  return { ...base, ...over };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

describe("liveState", () => {
  test("a run last heard from exactly 3 minutes ago is still live; one millisecond later it is stale", () => {
    expect(liveState(run({}, { agoMs: LIVE_STALE_MS }).hub, NOW)?.kind).toBe("live");
    expect(liveState(run({}, { agoMs: LIVE_STALE_MS + 1 }).hub, NOW)?.kind).toBe("stale");
  });

  test("a stale run reports the whole minutes of silence", () => {
    expect(liveState(run({}, { agoMs: 4 * 60_000 + 20_000 }).hub, NOW)).toMatchObject({ kind: "stale", machine: "ann-mbp", minutes: 4 });
  });

  test("a finished upload or a laptop run has no live state", () => {
    expect(liveState(run({}, null).hub, NOW)).toBeNull();
    expect(liveState(null, NOW)).toBeNull();
    expect(isLiveRun(run({}, null))).toBe(false);
    expect(isLiveRun(run())).toBe(true);
  });
});

describe("checkProgress", () => {
  test("resolved checks over the total, with the failing count", () => {
    expect(checkProgress([check("C1", "pass"), check("C2", "fail"), check("C3", "blocked"), check("C4", "running"), check("C5", "pending")])).toEqual({ done: 3, total: 5, failing: 1 });
    expect(checkProgress([])).toEqual({ done: 0, total: 0, failing: 0 });
  });
});

describe("LiveStatus", () => {
  test("live: names the machine, a green dot and the freshness", () => {
    const html = renderToStaticMarkup(createElement(LiveStatus, { hub: run().hub, now: NOW }));
    expect(text(html)).toContain("Live from ann-mbp");
    expect(text(html)).toContain("updated 10s ago");
    expect(html).toContain("bg-emerald-500");
    expect(text(html)).not.toContain("No update");
  });

  test("stale: amber warning with the minutes instead of the live label", () => {
    const html = renderToStaticMarkup(createElement(LiveStatus, { hub: run({}, { agoMs: 5 * 60_000 + 1000 }).hub, now: NOW }));
    expect(text(html)).toContain("No update from ann-mbp for 5 min");
    expect(text(html)).not.toContain("Live from");
    expect(html).toContain("text-amber-");
  });

  test("compact (cards and lists): the machine is shown elsewhere", () => {
    const live = text(renderToStaticMarkup(createElement(LiveStatus, { hub: run().hub, now: NOW, compact: true })));
    expect(live).toContain("Live");
    expect(live).not.toContain("ann-mbp");
    const stale = text(renderToStaticMarkup(createElement(LiveStatus, { hub: run({}, { agoMs: 4 * 60_000 }).hub, now: NOW, compact: true })));
    expect(stale).toContain("No update for 4 min");
  });
});

describe("a live run's panes", () => {
  test("the device pane says the screen arrives when the run finishes", () => {
    const html = render(createElement(DevicePane, { run: run(), device: null, gallery: [], selectedCheck: null, onClearSelection: () => {}, onOpenImage: () => {} }));
    expect(text(html)).toContain(LIVE_PENDING_COPY);
    expect(text(html)).toContain("The screen, activity and screenshots arrive when the run finishes.");
    expect(text(html)).not.toContain("did not save any screenshots");
  });

  test("the timeline says so too, instead of 'Starting agent session'", () => {
    const html = render(createElement(Timeline, { run: run(), activity: [], hasMore: false, loadEarlier: async () => {}, selectedCheck: null, onSelectCheck: () => {} }));
    expect(text(html)).toContain(LIVE_PENDING_COPY);
    expect(text(html)).not.toContain("Starting agent session");
  });

  test("a finished hub run keeps the normal empty states", () => {
    const finished = run({ status: "done", endedAt: iso(1000) }, null);
    const pane = render(createElement(DevicePane, { run: finished, device: null, gallery: [], selectedCheck: null, onClearSelection: () => {}, onOpenImage: () => {} }));
    expect(text(pane)).toContain("No screenshots");
    expect(text(pane)).not.toContain(LIVE_PENDING_COPY);
    const timeline = render(createElement(Timeline, { run: finished, activity: [], hasMore: false, loadEarlier: async () => {}, selectedCheck: null, onSelectCheck: () => {} }));
    expect(text(timeline)).toContain("No activity was recorded");
  });

  test("the pending state names the machine", () => {
    expect(text(renderToStaticMarkup(createElement(LivePendingState, { machine: "ann-mbp" })))).toContain("ann-mbp");
  });
});

describe("ActiveCard on the hub", () => {
  const props = { device: undefined, projectName: "Acme Shop", deviceName: null, now: NOW, onChanged: () => {} };

  test("shows the machine, the check progress and the live label, with no device frame or 'assigning device'", () => {
    const html = render(createElement(ActiveCard, { ...props, run: run() }));
    const shown = text(html);
    expect(shown).toContain("Checkout total updates");
    expect(shown).toContain("ann-mbp");
    expect(shown).toContain("1 pass");
    expect(shown).toContain("1 fail");
    expect(shown).toContain("2 remaining");
    expect(shown).toContain("Live");
    expect(shown).not.toContain("assigning device");
    expect(html).not.toContain("data-part=");
  });

  test("a stale run shows the amber no-update label", () => {
    const shown = text(render(createElement(ActiveCard, { ...props, run: run({}, { agoMs: 6 * 60_000 }) })));
    expect(shown).toContain("No update for 6 min");
  });

  test("a laptop run still shows its device frame and 'assigning device…'", () => {
    const laptop = run({ hub: undefined, deviceSerial: null });
    const html = render(createElement(ActiveCard, { ...props, run: laptop }));
    expect(text(html)).toContain("assigning device");
    expect(html).toContain("data-part=");
  });
});

describe("RunningNow", () => {
  const quiet = run({ id: "r2", title: "Login with saved account", checks: [check("C1", "pass"), check("C2", "pass")], hub: run({}, { agoMs: 7 * 60_000 }).hub });
  const rows = [run({ id: "r1", title: "Checkout total updates" }), quiet];
  const base = { runs: rows, loading: false, error: null, now: NOW };

  test("lists each live run: title, machine, n/m checks, failing count and label, linking to the run", () => {
    const html = renderToStaticMarkup(createElement(RunningNow, base));
    const shown = text(html);
    expect(shown).toContain("Running now");
    expect(shown).toContain("Checkout total updates");
    expect(shown).toContain("ann-mbp");
    expect(shown).toContain("2/4 checks");
    expect(shown).toContain("1 failing");
    expect(shown).toContain("2/2 checks");
    expect(shown).toContain("No update for 7 min");
    expect(html).toContain('href="#/runs/r1"');
    expect(html).toContain("text-red-");
  });

  test("a run with no failing check shows no failing count", () => {
    const shown = text(renderToStaticMarkup(createElement(RunningNow, { ...base, runs: [quiet] })));
    expect(shown).not.toContain("failing");
  });

  test("is absent when nothing is running", () => {
    expect(renderToStaticMarkup(createElement(RunningNow, { ...base, runs: [] }))).toBe("");
  });

  test("finished and laptop runs never appear", () => {
    expect(renderToStaticMarkup(createElement(RunningNow, { ...base, runs: [run({}, null), run({ hub: undefined })] }))).toBe("");
  });

  test("shows a skeleton while loading and an alert when the list failed", () => {
    const loading = renderToStaticMarkup(createElement(RunningNow, { ...base, runs: [], loading: true }));
    expect(loading).toContain('aria-label="Loading running runs"');
    const failed = renderToStaticMarkup(createElement(RunningNow, { ...base, runs: [], error: "boom" }));
    expect(text(failed)).toContain("Could not load running runs");
    expect(text(failed)).toContain("boom");
  });
});
