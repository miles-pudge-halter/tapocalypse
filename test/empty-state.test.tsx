import { describe, expect, test } from "bun:test";
import type { LucideIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "../web/components/empty-state";

const TestIcon = (() => <svg data-marker="test-icon" />) as unknown as LucideIcon;

describe("EmptyState", () => {
  test("with an icon renders the icon, title, description and action", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon={TestIcon}
        title="Nothing here"
        description="Add something"
        action={<button type="button">Add</button>}
      />,
    );
    expect(html).toContain('data-marker="test-icon"');
    expect(html).toContain("Nothing here");
    expect(html).toContain("Add something");
    expect(html).toContain("<button");
  });

  test("with media renders the media in place of the icon, keeping title, description and action", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        media={<div data-marker="custom-media" />}
        title="Welcome"
        description="Get started"
        action={<button type="button">Go</button>}
      />,
    );
    expect(html).toContain('data-marker="custom-media"');
    expect(html).not.toContain('data-marker="test-icon"');
    expect(html).toContain("Welcome");
    expect(html).toContain("Get started");
    expect(html).toContain("<button");
  });

  test("media comes before the title", () => {
    const html = renderToStaticMarkup(<EmptyState media={<div data-marker="custom-media" />} title="Welcome" />);
    expect(html.indexOf("custom-media")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("custom-media")).toBeLessThan(html.indexOf("Welcome"));
  });
});
