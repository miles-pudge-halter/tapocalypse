import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KpiTiles } from "../web/components/hub/kpi-tiles";
import { TooltipProvider } from "../web/components/ui/tooltip";
import type { ProjectOverview } from "../web/lib/api";

function overview(passRate: ProjectOverview["passRate"], counts: Partial<ProjectOverview["counts"]> = {}): ProjectOverview {
  return {
    project: { id: "shop", name: "Acme Shop", hubKey: "github.com/acme/shop", defaultBranch: "main", firstSeenAt: null, lastUploadAt: null, lastUploadBy: null },
    ref: null,
    days: 30,
    trend: [],
    passRate,
    counts: { newlyFailing: 0, newlyFailingTests: 0, flaky: 0, suspects: 0, failingNow: 0, blockedNow: 0, tests: 0, ...counts },
    lanes: [],
    latestRelease: null,
    recent: [],
  };
}

function text(passRate: ProjectOverview["passRate"], counts: Partial<ProjectOverview["counts"]> = {}): string {
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(KpiTiles, { overview: overview(passRate, counts), projectId: "shop", refValue: null })));
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("flaky-checks tile", () => {
  const rate = { current: 0.5, previous: null, pass: 1, decided: 2 };
  test("a flaky check with no suspects never reads 'No flaky checks' under its count", () => {
    const shown = text(rate, { flaky: 1, suspects: 0 });
    expect(shown).not.toContain("No flaky checks");
    expect(shown).toContain("no suspects");
  });
  test("nothing flaky and nothing suspect says so", () => {
    expect(text(rate, { flaky: 0, suspects: 0 })).toContain("No flaky checks");
  });
  test("suspects are added to the caption", () => {
    expect(text(rate, { flaky: 2, suspects: 3 })).toContain("+3 suspects");
  });
});

describe("pass-rate tile", () => {
  test("a project whose runs are all recent shows its rate without claiming the earlier window had no runs", () => {
    const shown = text({ current: 0.5, previous: null, pass: 26, decided: 52 });
    expect(shown).toContain("26 of 52 runs passed");
    expect(shown).not.toContain("no runs in the previous");
  });
  test("with an earlier window the change is still shown", () => {
    expect(text({ current: 0.5, previous: 0.4, pass: 26, decided: 52 })).toContain("10 pts");
    expect(text({ current: 0.5, previous: 0.5, pass: 26, decided: 52 })).toContain("same as the 30 days before");
  });
});
