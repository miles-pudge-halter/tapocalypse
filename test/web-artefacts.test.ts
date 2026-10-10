import { describe, expect, test } from "bun:test";
import type { Check } from "../web/lib/api";
import { reportHash, screenshotUrl } from "../web/lib/api";
import { buildGallery, screenshotOfCheck } from "../web/components/run/evidence";

const dataRun = { id: "20260101-abc", projectId: "demo", storage: "data" } as const;
const legacyRun = { id: "20250101-old", projectId: "demo", storage: "repo" } as const;

function check(partial: Partial<Check> & Pick<Check, "id">): Check {
  return { title: partial.id, status: "pass", ...partial } as Check;
}

describe("screenshotUrl", () => {
  test("data runs are served from the run's own files route, segment by segment", () => {
    expect(screenshotUrl(dataRun, "screenshots/01 home.png")).toBe("/api/runs/20260101-abc/files/screenshots/01%20home.png");
  });

  test("legacy runs keep the project files route rooted at the reports dir", () => {
    expect(screenshotUrl(legacyRun, "qa/screenshots/run-x/01.png")).toBe("/files/demo/screenshots/run-x/01.png");
  });
});

describe("reportHash", () => {
  test("data runs are keyed by run id", () => {
    expect(reportHash("demo", { ...dataRun, reportPath: "report.md" })).toBe("#/p/demo/reports/20260101-abc");
  });

  test("legacy runs are keyed by the report file's basename", () => {
    expect(reportHash("demo", { ...legacyRun, reportPath: "qa/QA-REPORT-x.md" })).toBe("#/p/demo/reports/QA-REPORT-x.md");
  });
});

describe("gallery", () => {
  test("a data check screenshot that the listing already returned is not duplicated", () => {
    const url = screenshotUrl(dataRun, "screenshots/01-home.png");
    const gallery = buildGallery(
      dataRun,
      [check({ id: "C1", screenshot: "screenshots/01-home.png" })],
      [{ path: "screenshots/01-home.png", url, name: "01-home.png", mtime: "2026-01-01T00:00:00Z", checkId: "C1" }],
    );
    expect(gallery).toHaveLength(1);
    expect(screenshotOfCheck(dataRun, check({ id: "C1", screenshot: "screenshots/01-home.png" }), gallery)?.url).toBe(url);
  });

  test("a check screenshot missing from the listing still resolves through the run route", () => {
    const gallery = buildGallery(dataRun, [check({ id: "C2", screenshot: "screenshots/02.png" })], []);
    expect(gallery.map((g) => g.url)).toEqual(["/api/runs/20260101-abc/files/screenshots/02.png"]);
  });
});
