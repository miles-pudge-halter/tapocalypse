import { describe, expect, test } from "bun:test";
import { reportHtmlUrl } from "../web/lib/api";
import { formatExpiresIn } from "../web/lib/format";

describe("reportHtmlUrl", () => {
  test("opens inline by default and encodes the run id", () => {
    expect(reportHtmlUrl("20260101-abc")).toBe("/api/runs/20260101-abc/report.html");
    expect(reportHtmlUrl("a/b c")).toBe("/api/runs/a%2Fb%20c/report.html");
  });

  test("download asks the server for an attachment", () => {
    expect(reportHtmlUrl("20260101-abc", { download: true })).toBe("/api/runs/20260101-abc/report.html?download=1");
  });
});

describe("formatExpiresIn", () => {
  const now = Date.parse("2026-03-01T12:00:00Z");

  test("whole days and hours read naturally", () => {
    expect(formatExpiresIn("2026-03-08T12:00:00Z", now)).toBe("7 days");
    expect(formatExpiresIn("2026-03-02T12:00:00Z", now)).toBe("1 day");
    expect(formatExpiresIn("2026-03-01T17:00:00Z", now)).toBe("5 hours");
  });

  test("rounds up so a link never shows as expiring earlier than it does", () => {
    expect(formatExpiresIn("2026-03-08T11:00:00Z", now)).toBe("7 days");
    expect(formatExpiresIn("2026-03-01T12:20:00Z", now)).toBe("1 hour");
  });

  test("an expiry in the past reads as expired", () => {
    expect(formatExpiresIn("2026-03-01T11:00:00Z", now)).toBe("expired");
  });
});
