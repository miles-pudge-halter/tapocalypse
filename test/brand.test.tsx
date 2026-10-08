import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Lockup, LogoMark, Wordmark } from "../web/components/brand";

function ids(html: string): string[] {
  return [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("LogoMark variants", () => {
  test("below 48 renders the micro drawing: full-bleed tile, no defs", () => {
    for (const size of [31, 32, 47]) {
      const html = renderToStaticMarkup(<LogoMark size={size} />);
      expect(html).toContain('rx="46"');
      expect(html).not.toContain("<defs");
      expect(html).not.toContain("<ellipse");
    }
  });

  test("48 to 95 renders the flat drawing: one ripple, no defs", () => {
    for (const size of [48, 95]) {
      const html = renderToStaticMarkup(<LogoMark size={size} />);
      expect(html.match(/<ellipse/g)?.length).toBe(1);
      expect(html).not.toContain("<defs");
      expect(html).not.toContain('rx="46"');
    }
  });

  test("96 and above renders the full drawing with gradients", () => {
    for (const size of [96, 160]) {
      const html = renderToStaticMarkup(<LogoMark size={size} />);
      expect(html).toContain("<defs");
      expect(html).toContain("<linearGradient");
    }
  });

  test("defaults to 32 px", () => {
    const html = renderToStaticMarkup(<LogoMark />);
    expect(html).toContain('width="32"');
    expect(html).toContain('rx="46"');
  });
});

describe("LogoMark accessibility", () => {
  test("is decorative without a title", () => {
    const html = renderToStaticMarkup(<LogoMark />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });

  test("with a title it is an labelled image", () => {
    const html = renderToStaticMarkup(<LogoMark title="Tapocalypse logo" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Tapocalypse logo"');
    expect(html).not.toContain("aria-hidden");
  });
});

describe("LogoMark full variant ids", () => {
  test("two instances in one tree get distinct ids and each references its own", () => {
    const html = renderToStaticMarkup(
      <div>
        <LogoMark size={96} />
        <LogoMark size={96} />
      </div>,
    );
    const all = ids(html);
    expect(all.length).toBe(6);
    expect(new Set(all).size).toBe(6);
    const [first, second] = html.split("</span>");
    for (const half of [first ?? "", second ?? ""]) {
      const own = ids(half);
      expect(own.length).toBe(3);
      for (const id of own) expect(half).toContain(`url(#${id})`);
      for (const id of own) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe("Wordmark", () => {
  test("is a labelled image", () => {
    const html = renderToStaticMarkup(<Wordmark />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Tapocalypse"');
  });

  test("a className override replaces the default height", () => {
    const html = renderToStaticMarkup(<Wordmark className="h-7" />);
    expect(html).toContain("h-7");
    expect(html).not.toMatch(/class="[^"]*\bh-3\b/);
  });
});

describe("Lockup", () => {
  test("sm has a micro mark and a wordmark but no tagline row", () => {
    const html = renderToStaticMarkup(<Lockup size="sm" />);
    expect(html).not.toContain("<defs");
    expect(html).toContain('aria-label="Tapocalypse"');
    expect(html).not.toContain("font-mono");
  });

  test("lg has the full mark, the wordmark and a tagline row", () => {
    const html = renderToStaticMarkup(<Lockup size="lg" />);
    expect(html).toContain("<defs");
    expect(html).toContain('aria-label="Tapocalypse"');
    expect(html).toContain("font-mono");
  });
});
