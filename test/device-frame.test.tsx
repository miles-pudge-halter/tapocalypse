import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_ASPECT, DeviceChrome, deviceAspect } from "../web/components/device-frame";

type Type = Parameters<typeof deviceAspect>[0];
type Platform = Parameters<typeof DeviceChrome>[0]["platform"];

const chrome = (deviceType: Type, platform: Platform, aspect: number) =>
  renderToStaticMarkup(
    <DeviceChrome deviceType={deviceType} platform={platform} aspect={aspect} style={{ width: 100 }}>
      <i data-marker="content" />
    </DeviceChrome>,
  );

const has = (html: string, part: string) => html.includes(`data-part="${part}"`);

describe("deviceAspect", () => {
  test("natural image size wins over the reported screen and the default", () => {
    expect(deviceAspect("phone", "1080×2400", 0.5)).toBe(0.5);
    expect(deviceAspect("watch", null, 1.5)).toBe(1.5);
  });

  test("parses the screen string with × and x", () => {
    expect(deviceAspect("phone", "1080×2400", null)).toBeCloseTo(0.45, 5);
    expect(deviceAspect("tablet", "2560 x 1600", null)).toBeCloseTo(1.6, 5);
    expect(deviceAspect("tablet", "2560x1600", null)).toBeCloseTo(1.6, 5);
  });

  test("out-of-range candidates fall through to the next source", () => {
    expect(deviceAspect("phone", "1080×2400", 10)).toBeCloseTo(0.45, 5);
    expect(deviceAspect("phone", "1080×2400", 0.1)).toBeCloseTo(0.45, 5);
    expect(deviceAspect("tv", "10×1", 10)).toBe(16 / 9);
    expect(deviceAspect("tv", "1×10", 0.1)).toBe(16 / 9);
  });

  test("unparseable screen and non-finite natural size fall back to the type default", () => {
    expect(deviceAspect("phone", "garbage", null)).toBe(DEFAULT_ASPECT.phone);
    expect(deviceAspect("tablet", null, Number.NaN)).toBe(DEFAULT_ASPECT.tablet);
    expect(deviceAspect("watch", "0×0", null)).toBe(DEFAULT_ASPECT.watch);
  });

  test("portrait defaults per type, tv is landscape, unknown is phone-shaped", () => {
    expect(deviceAspect("phone", null, null)).toBeLessThan(1);
    expect(deviceAspect("tablet", null, null)).toBeLessThan(1);
    expect(deviceAspect("watch", null, null)).toBeLessThan(1);
    expect(deviceAspect("tv", null, null)).toBeGreaterThan(1);
    expect(deviceAspect("unknown", null, null)).toBe(deviceAspect("phone", null, null));
  });
});

describe("DeviceChrome", () => {
  test("the screen carries the given aspect ratio and wraps the children", () => {
    const html = chrome("phone", "android", 0.5);
    const screen = html.match(/<div[^>]*data-part="screen"[^>]*>/)?.[0] ?? "";
    expect(screen).toMatch(/aspect-ratio:\s*0\.5/);
    expect(html.indexOf('data-part="screen"')).toBeLessThan(html.indexOf('data-marker="content"'));
  });

  test("iOS phone in portrait has the island, Android the punch-hole", () => {
    const ios = chrome("phone", "ios", 9 / 19.5);
    expect(has(ios, "notch")).toBe(true);
    expect(has(ios, "punch")).toBe(false);
    const android = chrome("phone", "android", 9 / 19.5);
    expect(has(android, "punch")).toBe(true);
    expect(has(android, "notch")).toBe(false);
  });

  test("a phone in landscape has neither", () => {
    for (const platform of ["ios", "android"] as const) {
      const html = chrome("phone", platform, 19.5 / 9);
      expect(has(html, "notch")).toBe(false);
      expect(has(html, "punch")).toBe(false);
    }
  });

  test("a watch has a crown and a side button but no notch", () => {
    const html = chrome("watch", "ios", 410 / 502);
    expect(has(html, "crown")).toBe(true);
    expect(has(html, "side-button")).toBe(true);
    expect(has(html, "notch")).toBe(false);
    expect(has(html, "stand")).toBe(false);
  });

  test("a tv has a stand and nothing else", () => {
    const html = chrome("tv", "android", 16 / 9);
    expect(has(html, "stand")).toBe(true);
    expect(has(html, "crown")).toBe(false);
    expect(has(html, "notch")).toBe(false);
    expect(has(html, "punch")).toBe(false);
  });

  test("tablet and unknown have no decorations", () => {
    for (const type of ["tablet", "unknown"] as const) {
      const html = chrome(type, "ios", 3 / 4);
      for (const part of ["notch", "punch", "crown", "side-button", "stand"]) expect(has(html, part)).toBe(false);
    }
  });
});
