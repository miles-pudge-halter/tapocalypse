#!/usr/bin/env bun
/**
 * Maintainer tool: seeds a throwaway demo instance (fictional "Acme Shop" project, ~22 finished runs over the last four
 * days) for screenshots and demos. `bun scripts/seed-demo.ts [--dir <dataDir>] [--config <file>] [--repo <dir>]`.
 * Runs are stored like real ones (`storage: "data"`: `report.md` and `screenshots/` in the run dir) except the two oldest, which
 * are legacy `storage: "repo"` runs with report and screenshots under the temp repo's `qa/`.
 * Never touches the real data dir unless `--dir` points at it, and refuses to write into a data dir that already has runs.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Device } from "../src/devices/devices";
import type { HarnessId } from "../src/harness/types";
import { deriveVerdict } from "../src/runs/outcome";
import type { Check, CheckStatus, ErrorKind, Platform, Run, RunUsage, Verdict } from "../src/runs/types";

const ROOT = path.resolve(import.meta.dir, "..");
const SCREENS_DIR = path.join(import.meta.dir, "demo", "screens");
const PERSONA_FILE = path.join(ROOT, "personas", "default-mobile-qa.md");

const PROJECT_ID = "acme-shop";
const PACKAGE_ID = "com.acme.shop.dev";
const REMOTE_URL = "https://github.com/acme/shop";
const RUN_MAX_TIME = "12m";
const MIN = 60_000;

type Screen = "home" | "product" | "cart" | "checkout" | "settings";
type DeviceKey = "pixel" | "iphone";

interface DemoDevice {
  platform: Platform;
  serial: string;
  name: string;
  /** What mobile-mcp is given: AVD name for emulators, UDID for simulators. */
  label: string;
  osVersion: string;
  screen: string;
}

const DEVICES: Record<DeviceKey, DemoDevice> = {
  pixel: { platform: "android", serial: "emulator-5554", name: "Pixel 8", label: "Pixel_8_API_35", osVersion: "Android 15", screen: "1080×2400" },
  iphone: {
    platform: "ios",
    serial: "4F2B8E1C-7A39-4D56-B0E4-93C1D2A85F70",
    name: "iPhone 16",
    label: "4F2B8E1C-7A39-4D56-B0E4-93C1D2A85F70",
    osVersion: "iOS 18.2",
    screen: "1170×2532",
  },
};

/** The two fictional devices of the demo, in the wire shape of `GET /api/devices` (the real ones are not shown in screenshots). */
export const DEMO_DEVICES: Device[] = [
  {
    serial: DEVICES.pixel.serial,
    platform: "android",
    kind: "emulator",
    model: "Pixel 8",
    name: DEVICES.pixel.name,
    osVersion: DEVICES.pixel.osVersion,
    screen: "1080×2400",
    deviceType: "phone",
    state: "ready",
    avdName: DEVICES.pixel.label,
    idleShutdownAt: null,
  },
  {
    serial: DEVICES.iphone.serial,
    platform: "ios",
    kind: "simulator",
    model: "iPhone 16",
    name: DEVICES.iphone.name,
    osVersion: DEVICES.iphone.osVersion,
    screen: null,
    deviceType: "phone",
    state: "ready",
    idleShutdownAt: null,
  },
];

interface HarnessDemo {
  model: string;
  effort: string;
  /** Codex reports tokens only. */
  hasCost: boolean;
}

const HARNESSES: Record<HarnessId, HarnessDemo> = {
  omp: { model: "anthropic/claude-sonnet-5-5", effort: "medium", hasCost: true },
  claude: { model: "sonnet", effort: "medium", hasCost: true },
  codex: { model: "gpt-5-codex", effort: "medium", hasCost: false },
};

interface CheckSpec {
  title: string;
  /** Screen whose screenshot is the evidence. */
  screen: Screen;
  /** Tiny DSL: `launch`, `reset`, `restart`, `back`, `tap:<label>`, `type:<text>`, `swipe:<dir>`, `open:<url>`, `sh:<command>`. */
  steps: string[];
  note: string;
}

interface Scenario {
  title: string;
  brief: string;
  checks: CheckSpec[];
}

const SCENARIOS: Record<string, Scenario> = {
  checkout: {
    title: "Checkout smoke",
    brief:
      "Smoke-test the happy path on the dev build: browse the catalog, open a product, add it to the cart and walk through checkout up to the order summary. Do not place a real order. Capture a screenshot per step.",
    checks: [
      { title: "Catalog loads with four products", screen: "home", steps: ["launch"], note: "Home shows Trail Runner, Canvas Tote, Rain Shell and Wool Beanie with prices." },
      { title: "Product detail opens from the catalog", screen: "product", steps: ["tap:Trail Runner"], note: "Detail page shows the size picker, price $129 and an Add to cart button." },
      { title: "Add to cart updates the cart", screen: "cart", steps: ["tap:Add to cart", "tap:Cart"], note: "Cart lists Trail Runner × 1, subtotal $129.00." },
      { title: "Quantity change recalculates totals", screen: "cart", steps: ["tap:+"], note: "Quantity 2 gives subtotal $258.00; shipping stays free over $100." },
      { title: "Checkout reaches the order summary", screen: "checkout", steps: ["tap:Checkout", "tap:Continue"], note: "Order summary lists shipping, tax and a Place order button; no order was placed." },
    ],
  },
  cartBadge: {
    title: "PR #142 — cart badge",
    brief:
      "Verify PR #142 (ACME-312): the cart icon in the app bar must show a badge with the number of items. Check adding, removing, large counts and persistence after a restart.",
    checks: [
      { title: "Badge is hidden on an empty cart", screen: "home", steps: ["launch"], note: "No badge on a fresh install." },
      { title: "Badge increments when adding items", screen: "home", steps: ["tap:Trail Runner", "tap:Add to cart", "back", "tap:Canvas Tote", "tap:Add to cart", "back"], note: "Badge reads 1, then 2 after adding Canvas Tote." },
      { title: "Badge decrements when removing an item", screen: "cart", steps: ["tap:Cart", "tap:Remove"], note: "Badge reads 1 after removing Canvas Tote." },
      { title: "Badge copes with three-digit counts", screen: "cart", steps: ["open:acme://debug/cart?items=120"], note: "Badge shows 99+." },
    ],
  },
  onboarding: {
    title: "Onboarding on a fresh install",
    brief:
      "Clear the app data, launch the app and complete first-run onboarding. Check the welcome carousel, the notification permission prompt and the regional defaults.",
    checks: [
      { title: "Welcome carousel shows three slides", screen: "home", steps: ["reset", "launch", "swipe:left", "swipe:left"], note: "Three slides, the page dots update and Skip is visible on every slide." },
      { title: "Skip leads to the catalog", screen: "home", steps: ["tap:Skip"], note: "Catalog is shown with no leftover overlay." },
      { title: "Notification permission is requested once", screen: "settings", steps: ["tap:Allow"], note: "The system prompt appears after the carousel, once; Allow is remembered." },
      { title: "Currency and region follow the device locale", screen: "settings", steps: ["tap:Account", "tap:Region"], note: "USD and United States are preselected for an en-US device." },
    ],
  },
  darkMode: {
    title: "Dark mode survives restart",
    brief:
      "Switch the app to the dark theme, force-stop it and relaunch. The theme must persist across restarts and apply to the product and checkout screens.",
    checks: [
      { title: "Switch to the dark theme in Settings", screen: "settings", steps: ["tap:Account", "tap:Appearance", "tap:Dark"], note: "Appearance row reads Dark and the app bar switches immediately." },
      { title: "Theme persists after a force-stop", screen: "home", steps: ["restart"], note: "App relaunches in the dark theme with no light flash." },
      { title: "Product detail respects the dark theme", screen: "product", steps: ["tap:Trail Runner"], note: "Text, price and the Add to cart button use the dark palette." },
      { title: "Checkout respects the dark theme", screen: "checkout", steps: ["tap:Cart", "tap:Checkout"], note: "Form fields keep readable contrast." },
    ],
  },
  promo: {
    title: "Promo codes at checkout",
    brief:
      "Exercise the promo code field on the checkout screen: a valid code, an expired code, an empty submission, and a code surviving cart edits. Ticket ACME-318.",
    checks: [
      { title: "Valid code SAVE10 takes 10% off", screen: "checkout", steps: ["tap:Promo code", "type:SAVE10", "tap:Apply"], note: "Discount of $12.90 is shown and the total updates." },
      { title: "Expired code shows an inline error", screen: "checkout", steps: ["type:SUMMER23", "tap:Apply"], note: "Inline error: this code has expired." },
      { title: "Empty code is rejected", screen: "checkout", steps: ["tap:Apply"], note: "Empty code is rejected with a validation message." },
      { title: "Applied code survives cart edits", screen: "cart", steps: ["tap:Cart", "tap:+"], note: "Discount is recalculated for the new subtotal." },
    ],
  },
  search: {
    title: "Search and filters",
    brief: "Check the catalog search and category chips: matching, filtering, the empty-results state and clearing filters.",
    checks: [
      { title: "Search finds products by name", screen: "home", steps: ["tap:Search", "type:shell"], note: "Only Rain Shell is listed." },
      { title: "Category chip filters the grid", screen: "home", steps: ["tap:Bags"], note: "Canvas Tote is the only product left." },
      { title: "No-results state is shown", screen: "home", steps: ["tap:Search", "type:zzz"], note: "Empty state with a Clear search action." },
      { title: "Clearing filters restores the list", screen: "home", steps: ["tap:All"], note: "All four products are back." },
    ],
  },
  addressBook: {
    title: "Address book",
    brief: "Add, edit and delete a shipping address from Settings and confirm checkout picks up the changes.",
    checks: [
      { title: "Add a shipping address", screen: "settings", steps: ["tap:Account", "tap:Addresses", "tap:Add address", "type:12 Market Street"], note: "Address is saved and marked as default." },
      { title: "Edited address shows up at checkout", screen: "checkout", steps: ["tap:Edit", "type:14 Market Street", "tap:Cart", "tap:Checkout"], note: "Checkout shows 14 Market Street." },
      { title: "Deleting the address clears the default", screen: "settings", steps: ["tap:Account", "tap:Addresses", "tap:Delete"], note: "Checkout asks for a new address." },
    ],
  },
  wishlist: {
    title: "Wishlist sync",
    brief: "Add an item to the wishlist and verify it is listed in the Wishlist tab and still there after an app restart. ACME-327.",
    checks: [
      { title: "Heart toggles an item into the wishlist", screen: "product", steps: ["tap:Trail Runner", "tap:Heart"], note: "Heart fills and a Saved snackbar appears." },
      { title: "Wishlist tab lists the item", screen: "home", steps: ["tap:Account", "tap:Wishlist"], note: "Trail Runner is listed with its price." },
      { title: "Item persists after an app restart", screen: "home", steps: ["restart", "tap:Account", "tap:Wishlist"], note: "Wishlist still contains Trail Runner." },
    ],
  },
  login: {
    title: "Login and session restore",
    brief: "Sign in with the shared QA account, kill the app, and verify the session is restored without asking for credentials again.",
    checks: [
      { title: "Sign in with the QA account", screen: "settings", steps: ["tap:Account", "type:qa@acme.example", "tap:Sign in"], note: "Signed in." },
      { title: "Session survives a force-stop", screen: "settings", steps: ["restart"], note: "Account row shows the QA user." },
      { title: "Sign out clears the session", screen: "settings", steps: ["tap:Sign out"], note: "Signed out." },
    ],
  },
  push: {
    title: "Push notification deep link",
    brief: "Send a test push for a product and tap it from the notification shade: with the app in the background and from a cold start. ACME-309.",
    checks: [
      { title: "Tap opens the product from the background", screen: "product", steps: ["sh:push", "tap:Acme Shop notification"], note: "Trail Runner detail opens directly." },
      { title: "Tap opens the product from a cold start", screen: "product", steps: ["sh:force-stop", "sh:push", "tap:Acme Shop notification"], note: "Trail Runner detail opens after the splash screen." },
      { title: "Price in the notification matches the product page", screen: "product", steps: ["sh:push"], note: "Both show $129." },
    ],
  },
  release: {
    title: "Release 2.4 regression pass",
    brief:
      "Full regression pass on the release/2.4 branch: cold start, catalog, product gallery, cart, promo codes, order confirmation, cart reset after ordering and the language switch.",
    checks: [
      { title: "Cold start reaches the catalog quickly", screen: "home", steps: ["restart"], note: "Cold start 1.8 s to an interactive catalog." },
      { title: "Catalog loads and scrolls", screen: "home", steps: ["swipe:up"], note: "Four products, smooth scroll, no layout jumps." },
      { title: "Product gallery swipes", screen: "product", steps: ["tap:Trail Runner", "swipe:left"], note: "Four photos, counter updates." },
      { title: "Add to cart and edit quantity", screen: "cart", steps: ["tap:Add to cart", "tap:Cart", "tap:+"], note: "Subtotal $258.00." },
      { title: "Promo code SAVE10 applies at checkout", screen: "checkout", steps: ["tap:Checkout", "type:SAVE10", "tap:Apply"], note: "Total $232.20 with free shipping." },
      { title: "Order confirmation shows the right total", screen: "checkout", steps: ["tap:Place order"], note: "Confirmation shows $232.20." },
      { title: "Cart is emptied after an order", screen: "cart", steps: ["tap:Cart"], note: "Cart is empty." },
      { title: "Language switch to Español", screen: "settings", steps: ["tap:Account", "tap:Language", "tap:Español"], note: "Catalog and checkout are translated." },
    ],
  },
  language: {
    title: "Settings: language switch",
    brief: "Switch the app language in Settings and confirm the catalog is translated and the choice survives a restart.",
    checks: [
      { title: "Language list shows English, Español and Deutsch", screen: "settings", steps: ["tap:Account", "tap:Language"], note: "Three languages, current one ticked." },
      { title: "Switching to Español translates the catalog", screen: "home", steps: ["tap:Español", "back"], note: "Tabs read Tienda, Buscar, Carrito, Cuenta." },
      { title: "Language persists after a restart", screen: "settings", steps: ["restart"], note: "App relaunches in Español." },
    ],
  },
  cartPersist: {
    title: "Cart persistence after force-stop",
    brief: "Fill the cart, force-stop the app and relaunch: the cart must still hold its items, and also after going offline.",
    checks: [
      { title: "Add two items to the cart", screen: "cart", steps: ["tap:Trail Runner", "tap:Add to cart", "back", "tap:Wool Beanie", "tap:Add to cart", "tap:Cart"], note: "Cart lists two items, subtotal $158.00." },
      { title: "Cart survives a force-stop", screen: "cart", steps: ["restart", "tap:Cart"], note: "Both items are still in the cart." },
      { title: "Cart is readable while offline", screen: "cart", steps: ["sh:airplane-on", "tap:Cart"], note: "Cart renders from the local cache; airplane mode restored afterwards." },
    ],
  },
  guest: {
    title: "Guest checkout",
    brief: "Buy one item as a guest without creating an account: shipping details, card payment with the test card, order confirmation.",
    checks: [
      { title: "Add an item and start checkout as a guest", screen: "cart", steps: ["tap:Trail Runner", "tap:Add to cart", "tap:Cart", "tap:Checkout as guest"], note: "Guest checkout form opens." },
      { title: "Shipping form validates required fields", screen: "checkout", steps: ["tap:Continue", "type:Alex Doe", "type:12 Market Street"], note: "Required fields are flagged, then accepted." },
      { title: "Pay with the test card", screen: "checkout", steps: ["type:4242 4242 4242 4242", "type:12/30", "tap:Place order"], note: "Order is placed." },
      { title: "Order confirmation screen", screen: "checkout", steps: [], note: "Confirmation shows the order number." },
    ],
  },
  a11y: {
    title: "Accessibility sweep",
    brief: "Check the main screens with the screen reader on, the largest text size and touch target sizes. Report labels that are missing or misleading.",
    checks: [
      { title: "Screen reader labels on the catalog", screen: "home", steps: ["launch", "tap:Trail Runner"], note: "Every product card announces name and price." },
      { title: "Large text keeps layouts intact", screen: "product", steps: ["sh:font-scale"], note: "No clipped text at 200% font scale." },
      { title: "Touch targets are at least 48 dp", screen: "cart", steps: ["tap:Cart", "sh:uiautomator"], note: "All targets are at least 48 dp." },
      { title: "Contrast in the dark theme", screen: "settings", steps: ["tap:Account", "tap:Appearance"], note: "Contrast meets AA." },
    ],
  },
  gallery: {
    title: "Product gallery swipe",
    brief: "Open the product photo gallery, swipe through all photos and make sure pinch-to-zoom resets when the gallery closes.",
    checks: [
      { title: "Gallery opens full-screen on tap", screen: "product", steps: ["tap:Trail Runner", "tap:photo"], note: "Photo fills the screen with a close button." },
      { title: "Swipe moves between the four photos", screen: "product", steps: ["swipe:left", "swipe:left", "swipe:left"], note: "Counter runs from 1/4 to 4/4." },
      { title: "Zoom resets when the gallery closes", screen: "product", steps: ["tap:close", "tap:photo"], note: "Reopened photo is at 100%." },
    ],
  },
};

interface Override {
  status: CheckStatus;
  note: string;
}

interface Branch {
  commitSubject: string;
  versionName: string;
  versionCode: string;
}

const BRANCHES: Record<string, Branch> = {
  main: { commitSubject: "Merge pull request #139 from acme/fix-cart-rounding", versionName: "2.5.0", versionCode: "2431" },
  "feat/cart-badge": { commitSubject: "Show item count badge on the cart icon", versionName: "2.5.0", versionCode: "2436" },
  "release/2.4": { commitSubject: "Bump version to 2.4.0+2417", versionName: "2.4.0", versionCode: "2417" },
};

interface RunSpec {
  scenario: keyof typeof SCENARIOS;
  /** Overrides the scenario title. */
  title?: string;
  harness: HarnessId;
  device: DeviceKey;
  branch: string;
  /** Minutes before the seed time at which the run started. */
  agoMin: number;
  durationMin: number;
  /** Per-check outcome overrides by 1-based check number; everything else passes with the scenario's note. */
  outcomes?: Record<number, Override>;
  /** The run's own verdict; when absent the verdict follows the checks. */
  verdict?: Verdict;
  summary?: string;
  requestedBy?: string;
  pr?: { number: number; title: string };
  tickets?: string[];
  /** Run ended abnormally: the agent never finished. */
  ending?: "cancelled" | "timeout" | "infra";
  /** 1-based check that is still running when the run ended abnormally. */
  stopAt?: number;
  batch?: "onboarding";
  /** This run is the successor of the (infra-failed) run with this key. */
  retryOf?: string;
  key?: string;
  /** Stored the pre-data-dir way: report and screenshots under the temp repo's `qa/` (`storage: "repo"`). */
  legacy?: boolean;
}

const BLOCKED_LOGIN: Record<number, Override> = {
  1: { status: "blocked", note: "Sign-in is rejected with “Invalid credentials”; no QA account credentials were provided in the brief or the repository." },
  2: { status: "skipped", note: "Blocked by C1: there is no signed-in session to restore." },
  3: { status: "skipped", note: "Blocked by C1: nothing to sign out of." },
};

/** Newest first. 12 PASS, 3 PASS WITH ISSUES, 3 FAIL, 1 BLOCKED, 1 infra error with its retry, 1 cancelled, 1 derived PARTIAL. */
const RUN_SPECS: RunSpec[] = [
  { scenario: "checkout", harness: "claude", device: "pixel", branch: "main", agoMin: 28, durationMin: 6.4, summary: "The happy path from catalog to order summary works on the Pixel 8. All five checks passed with a screenshot each." },
  {
    scenario: "cartBadge",
    harness: "omp",
    device: "pixel",
    branch: "feat/cart-badge",
    agoMin: 82,
    durationMin: 9.2,
    requestedBy: "claude-code",
    pr: { number: 142, title: "Show item count badge on the cart icon" },
    tickets: ["ACME-312"],
    outcomes: { 4: { status: "fail", note: "Badge shows “120” and is clipped by the icon bounds; the design caps it at “99+”." } },
    verdict: "PASS WITH ISSUES",
    summary: "The badge appears, increments and decrements correctly. One cosmetic defect: counts above 99 overflow the badge instead of showing 99+.",
  },
  { scenario: "onboarding", harness: "omp", device: "pixel", branch: "main", agoMin: 150, durationMin: 5.8, batch: "onboarding", summary: "Onboarding works end to end on the Pixel 8: carousel, skip, notification prompt and locale defaults." },
  {
    scenario: "onboarding",
    harness: "omp",
    device: "iphone",
    branch: "main",
    agoMin: 150,
    durationMin: 7.9,
    batch: "onboarding",
    outcomes: { 3: { status: "fail", note: "The notification prompt appears over the second carousel slide, before the user reaches the last one." } },
    verdict: "PASS WITH ISSUES",
    summary: "Onboarding completes on the iPhone 16, but the notification permission prompt interrupts the carousel on slide two.",
  },
  { scenario: "darkMode", harness: "codex", device: "pixel", branch: "main", agoMin: 265, durationMin: 4.2, requestedBy: "cli", summary: "Dark theme is applied immediately and survives a force-stop; product and checkout both use the dark palette." },
  {
    scenario: "promo",
    harness: "claude",
    device: "pixel",
    branch: "release/2.4",
    agoMin: 340,
    durationMin: 8.6,
    tickets: ["ACME-318"],
    outcomes: {
      3: { status: "fail", note: "Promo code field accepts an empty code and shows a spinner forever; the form cannot be submitted until the app is restarted." },
      4: { status: "skipped", note: "Skipped: checkout is stuck on the spinner after C3 and needs an app restart." },
    },
    verdict: "FAIL",
    summary: "Valid and expired codes behave correctly, but submitting an empty promo code leaves checkout stuck on a spinner.",
  },
  { scenario: "search", harness: "omp", device: "pixel", branch: "main", agoMin: 425, durationMin: 5.2, summary: "Search, category chips, the empty state and clearing filters all behave as specified." },
  { scenario: "checkout", harness: "omp", device: "iphone", branch: "main", agoMin: 1500, durationMin: 6.1, summary: "Checkout smoke passes on the iPhone 16 simulator." },
  { scenario: "addressBook", harness: "claude", device: "pixel", branch: "main", agoMin: 1575, durationMin: 4.9, summary: "Adding, editing and deleting an address works and checkout reflects every change." },
  { scenario: "wishlist", harness: "omp", device: "pixel", branch: "main", agoMin: 1650, durationMin: 2.3, ending: "infra", key: "wishlist-1", tickets: ["ACME-327"] },
  { scenario: "wishlist", harness: "omp", device: "pixel", branch: "main", agoMin: 1646, durationMin: 5.5, retryOf: "wishlist-1", tickets: ["ACME-327"], summary: "Wishlist add, list and persistence work on the Pixel 8." },
  {
    scenario: "login",
    harness: "codex",
    device: "pixel",
    branch: "main",
    agoMin: 1760,
    durationMin: 3.4,
    outcomes: BLOCKED_LOGIN,
    verdict: "BLOCKED",
    summary: "Could not sign in: the staging backend rejects the QA account and no working credentials were available.",
  },
  {
    scenario: "push",
    harness: "claude",
    device: "pixel",
    branch: "main",
    agoMin: 1890,
    durationMin: 7.3,
    tickets: ["ACME-309"],
    outcomes: { 3: { status: "fail", note: "The notification says $119 while the product page shows $129 (stale sale price in the push payload)." } },
    verdict: "PASS WITH ISSUES",
    summary: "Deep links open the right product from the background and from a cold start. The price in the notification text is stale.",
  },
  {
    scenario: "release",
    harness: "omp",
    device: "pixel",
    branch: "release/2.4",
    agoMin: 2890,
    durationMin: 11.8,
    requestedBy: "ci",
    tickets: ["ACME-312"],
    outcomes: {
      6: { status: "fail", note: "Order confirmation shows a total of $0.00 after SAVE10 plus free shipping; the order summary before it showed $232.20." },
      7: { status: "fail", note: "The cart badge still shows 1 after the order was placed (ACME-312 regression)." },
    },
    verdict: "FAIL",
    summary: "Two release blockers: the order confirmation total is $0.00 after a promo code, and the cart badge is not cleared after ordering.",
  },
  { scenario: "language", harness: "claude", device: "iphone", branch: "main", agoMin: 2990, durationMin: 4.6, summary: "The language switch translates the catalog and persists after a restart." },
  { scenario: "onboarding", harness: "claude", device: "pixel", branch: "main", agoMin: 3080, durationMin: 2.7, ending: "cancelled", stopAt: 3 },
  { scenario: "cartPersist", harness: "omp", device: "pixel", branch: "main", agoMin: 3200, durationMin: 5, summary: "The cart survives a force-stop and renders offline." },
  {
    scenario: "guest",
    harness: "omp",
    device: "iphone",
    branch: "main",
    agoMin: 4310,
    durationMin: 9.5,
    outcomes: {
      3: { status: "fail", note: "Place order stays disabled after a valid test card (4242 4242 4242 4242, 12/30) is entered; the card field shows no validation error." },
      4: { status: "skipped", note: "Skipped: the order could not be placed (see C3)." },
    },
    verdict: "FAIL",
    summary: "Guest checkout cannot be completed on the iPhone 16: Place order stays disabled with a valid test card.",
  },
  {
    scenario: "a11y",
    harness: "codex",
    device: "pixel",
    branch: "feat/cart-badge",
    agoMin: 4420,
    durationMin: 12,
    ending: "timeout",
    stopAt: 4,
    outcomes: { 3: { status: "blocked", note: "Blocked: uiautomator dump timed out three times on the cart screen." } },
  },
  { scenario: "gallery", harness: "omp", device: "pixel", branch: "main", agoMin: 4540, durationMin: 4.4, summary: "The product gallery opens, swipes through all photos and resets zoom on close." },
  { scenario: "checkout", title: "Smoke on release candidate", harness: "claude", device: "pixel", branch: "release/2.4", agoMin: 5560, durationMin: 6.8, legacy: true, summary: "The release candidate passes the checkout smoke test." },
  { scenario: "checkout", harness: "omp", device: "pixel", branch: "main", agoMin: 5660, durationMin: 6, legacy: true, summary: "The happy path from catalog to order summary works." },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (text: string): string => createHash("sha1").update(text).digest("hex");
const hashInt = (text: string): number => parseInt(sha(text).slice(0, 8), 16);

const pad = (n: number): string => String(n).padStart(2, "0");

/** Same shape as the store's `makeRunId`, with a deterministic suffix. */
function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function runId(title: string, createdAt: Date, seed: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "run";
  return `${stamp(createdAt)}-${sha(seed).slice(0, 4)}-${slug}`;
}

type ToolCall =
  | { kind: "mcp"; name: string; args: Record<string, unknown>; result: string; error?: boolean }
  | { kind: "bash"; command: string; output: string }
  | { kind: "write"; path: string };

/** Writes `events.jsonl` lines in the raw frame format of one harness, so the real replay code renders the timeline. */
class Feed {
  readonly lines: string[] = [];
  toolCalls = 0;
  private seq = 0;

  constructor(
    private readonly harness: HarnessId,
    public t: number,
  ) {}

  private push(frame: object): void {
    this.lines.push(JSON.stringify({ ...frame, _ts: new Date(this.t).toISOString() }));
  }

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}_${this.seq.toString().padStart(3, "0")}`;
  }

  start(model: string): void {
    if (this.harness === "claude") {
      this.push({
        type: "system",
        subtype: "init",
        model,
        session_id: sha(`session-${this.t}`).slice(0, 32),
        mcp_servers: [
          { name: "tpc", status: "connected" },
          { name: "mobile-mcp", status: "connected" },
        ],
      });
    } else if (this.harness === "codex") {
      this.push({ type: "thread.started", thread_id: sha(`thread-${this.t}`).slice(0, 32) });
      this.push({ type: "turn.started" });
    }
  }

  activity(kind: string, text: string, extra: { checkId?: string; checkStatus?: CheckStatus } = {}): void {
    this.push({ type: "_activity", kind, text, ...extra });
  }

  say(text: string): void {
    switch (this.harness) {
      case "omp":
        this.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
        break;
      case "claude":
        this.push({ type: "assistant", message: { id: this.id("msg"), role: "assistant", content: [{ type: "text", text }] } });
        break;
      case "codex":
        this.push({ type: "item.completed", item: { id: this.id("item"), type: "agent_message", text } });
        break;
    }
  }

  /** Emits the call at the current time, advances the clock by `ms`, then emits its result. */
  tool(call: ToolCall, ms: number): void {
    this.toolCalls++;
    const id = this.id(this.harness === "claude" ? "toolu" : "call");
    const failed = call.kind === "mcp" && call.error === true;
    const text = call.kind === "mcp" ? call.result : call.kind === "bash" ? call.output : "";
    switch (this.harness) {
      case "omp": {
        const [toolName, args] =
          call.kind === "mcp"
            ? ["write", { path: `xd://mcp__tpc_mobile_mcp_${call.name}`, content: JSON.stringify(call.args) }]
            : call.kind === "bash"
              ? ["bash", { command: call.command }]
              : ["write", { path: call.path, content: "(report)" }];
        this.push({ type: "tool_execution_start", toolCallId: id, toolName, args });
        this.t += ms;
        this.push({ type: "tool_execution_end", toolCallId: id, toolName, isError: failed, result: { content: [{ type: "text", text: text || "ok" }] } });
        break;
      }
      case "claude": {
        const [name, input] =
          call.kind === "mcp"
            ? [`mcp__tpc__${call.name}`, call.args]
            : call.kind === "bash"
              ? ["Bash", { command: call.command }]
              : ["Write", { file_path: call.path, content: "(report)" }];
        this.push({ type: "assistant", message: { id: this.id("msg"), role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
        this.t += ms;
        this.push({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: failed, content: text || "ok" }] },
        });
        break;
      }
      case "codex": {
        const item =
          call.kind === "mcp"
            ? { id, type: "mcp_tool_call", server: "tpc", tool: call.name, arguments: call.args }
            : call.kind === "bash"
              ? { id, type: "command_execution", command: call.command, aggregated_output: "", exit_code: null }
              : { id, type: "file_change", changes: [{ path: call.path, kind: "add" }] };
        this.push({ type: "item.started", item: { ...item, status: "in_progress" } });
        this.t += ms;
        const done =
          call.kind === "mcp"
            ? { ...item, status: failed ? "failed" : "completed", result: { content: [{ type: "text", text }] } }
            : call.kind === "bash"
              ? { ...item, aggregated_output: text, exit_code: 0, status: "completed" }
              : { ...item, status: "completed" };
        this.push({ type: "item.completed", item: done });
        break;
      }
    }
  }

  end(usage: RunUsage, summary: string): void {
    if (this.harness === "claude") {
      this.push({ type: "result", subtype: "success", is_error: false, result: summary, total_cost_usd: usage.cost, num_turns: usage.toolCalls });
    } else if (this.harness === "codex") {
      this.push({
        type: "turn.completed",
        usage: { input_tokens: usage.tokensIn, cached_input_tokens: usage.cacheRead, output_tokens: usage.tokensOut, reasoning_output_tokens: Math.round(usage.tokensOut * 0.3) },
      });
    }
  }
}

interface Finished {
  run: Run;
  events: string;
  report: string | null;
  /** Evidence screenshots: path relative to the run's artefact root (the run dir for data runs, the repo's `qa/` for legacy ones) → screen name. */
  screenshots: { rel: string; screen: Screen }[];
}

/** Element-list text and tap coordinates for a label, stable per label and platform. */
function tapPoint(device: DemoDevice, label: string): { x: number; y: number } {
  const h = hashInt(`${device.platform}:${label}`);
  const [w, hgt] = device.platform === "android" ? [1080, 2400] : [393, 852];
  return { x: Math.round(w * 0.15 + (h % 1000) / 1000 * w * 0.7), y: Math.round(hgt * 0.2 + ((h >>> 10) % 1000) / 1000 * hgt * 0.6) };
}

interface StepCtx {
  device: DemoDevice;
  rand: () => number;
}

/** Tool calls of one DSL step, with their relative weights (bigger = slower). */
function stepCalls(step: string, ctx: StepCtx): { call: ToolCall; weight: number }[] {
  const { device } = ctx;
  const id = device.label;
  const [verb = "", ...rest] = step.split(":");
  const arg = rest.join(":");
  switch (verb) {
    case "launch":
      return [{ call: { kind: "mcp", name: "mobile_launch_app", args: { device: id, packageName: PACKAGE_ID }, result: `Launched ${PACKAGE_ID}` }, weight: 2 }];
    case "reset":
      return [
        {
          call:
            device.platform === "android"
              ? { kind: "bash", command: `adb -s ${device.serial} shell pm clear ${PACKAGE_ID}`, output: "Success" }
              : { kind: "bash", command: `xcrun simctl privacy ${device.serial} reset all ${PACKAGE_ID} && xcrun simctl terminate ${device.serial} ${PACKAGE_ID}`, output: "" },
          weight: 1.5,
        },
      ];
    case "restart":
      return [
        { call: { kind: "mcp", name: "mobile_terminate_app", args: { device: id, packageName: PACKAGE_ID }, result: `Terminated ${PACKAGE_ID}` }, weight: 1 },
        { call: { kind: "mcp", name: "mobile_launch_app", args: { device: id, packageName: PACKAGE_ID }, result: `Launched ${PACKAGE_ID}` }, weight: 2 },
      ];
    case "back":
      return [{ call: { kind: "mcp", name: "mobile_press_button", args: { device: id, button: device.platform === "android" ? "BACK" : "HOME" }, result: "Pressed button" }, weight: 0.6 }];
    case "tap": {
      const { x, y } = tapPoint(device, arg);
      return [
        { call: { kind: "mcp", name: "mobile_list_elements_on_screen", args: { device: id }, result: `Found 14 elements. "${arg}" is tappable at (${x}, ${y}).` }, weight: 3 },
        { call: { kind: "mcp", name: "mobile_click_on_screen_at_coordinates", args: { device: id, x, y }, result: `Tapped on coordinates (${x}, ${y})` }, weight: 0.8 },
      ];
    }
    case "type":
      return [{ call: { kind: "mcp", name: "mobile_type_keys", args: { device: id, text: arg, submit: false }, result: `Typed ${arg.length} characters` }, weight: 1 }];
    case "swipe": {
      const { x, y } = tapPoint(device, "swipe");
      return [{ call: { kind: "mcp", name: "mobile_swipe_on_screen", args: { device: id, direction: arg, x, y }, result: `Swiped ${arg}` }, weight: 1 }];
    }
    case "open":
      return [{ call: { kind: "mcp", name: "mobile_open_url", args: { device: id, url: arg }, result: `Opened ${arg}` }, weight: 1.5 }];
    case "sh": {
      const commands: Record<string, string> = {
        push: `adb -s ${device.serial} shell am broadcast -a com.acme.shop.TEST_PUSH --es product trail-runner`,
        "force-stop": `adb -s ${device.serial} shell am force-stop ${PACKAGE_ID}`,
        "airplane-on": `adb -s ${device.serial} shell cmd connectivity airplane-mode enable`,
        "font-scale": `adb -s ${device.serial} shell settings put system font_scale 2.0`,
        uiautomator: `adb -s ${device.serial} shell uiautomator dump /sdcard/ui.xml`,
      };
      return [{ call: { kind: "bash", command: commands[arg] ?? arg, output: "" }, weight: 1.5 }];
    }
    default:
      return [];
  }
}

/** Plausible usage for the harness; codex reports tokens only. */
function usageFor(harness: HarnessId, toolCalls: number, rand: () => number): RunUsage {
  const tokensIn = Math.round(toolCalls * (1500 + rand() * 600));
  const tokensOut = Math.round(toolCalls * (170 + rand() * 80));
  const cacheRead = Math.round(toolCalls * (9000 + rand() * 4000));
  const cacheWrite = harness === "codex" ? 0 : Math.round(12_000 + rand() * 9000);
  const cost = HARNESSES[harness].hasCost ? Math.round((tokensIn * 3 + tokensOut * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 100) / 10_000 : null;
  return { cost, tokensIn, tokensOut, cacheRead, cacheWrite, toolCalls, model: HARNESSES[harness].model };
}

const STATUS_ICON: Record<string, string> = { pass: "✅ pass", fail: "❌ fail", blocked: "⛔ blocked", skipped: "⤼ skipped" };

interface BuildContext {
  now: number;
  repoDir: string;
  dataDir: string;
  index: number;
  /** Ids of earlier-built runs by spec key (retry links point at the failed attempt). */
  ids: Map<string, string>;
  batchId: string | null;
}

function buildRun(spec: RunSpec, ctx: BuildContext): Finished {
  const scenario = SCENARIOS[spec.scenario]!;
  const title = spec.title ?? scenario.title;
  const device = DEVICES[spec.device];
  const runTitle = spec.batch ? `${title} · ${device.name}` : title;
  const harness = HARNESSES[spec.harness];
  const branch = BRANCHES[spec.branch]!;
  const rand = mulberry32(hashInt(`${title}:${ctx.index}`));

  const startMs = ctx.now - spec.agoMin * MIN;
  const queueMs = Math.round((12 + rand() * 25) * 1000);
  const createdAt = new Date(startMs - queueMs);
  const id = runId(runTitle, createdAt, `${runTitle}:${ctx.index}`);
  const durationMs = Math.round(spec.durationMin * MIN);
  const endMs = startMs + durationMs;
  // Data runs keep artefacts in `<runDir>/screenshots`; legacy runs in the repo's `qa/screenshots/<id>`.
  const legacy = spec.legacy === true;
  const runDir = path.join(ctx.dataDir, "runs", id);
  const shotPrefix = legacy ? `qa/screenshots/${id}` : "screenshots";
  const infra = spec.ending === "infra";

  const feed = new Feed(spec.harness, startMs + 4000);
  const checks: Check[] = [];
  const screenshots: Finished["screenshots"] = [];
  const iso = (ms: number) => new Date(ms).toISOString();
  const commit = sha(`${spec.branch}:${branch.commitSubject}`);
  const prInfo = spec.pr
    ? {
        number: spec.pr.number,
        title: spec.pr.title,
        url: `${REMOTE_URL}/pull/${spec.pr.number}`,
        state: "OPEN",
        baseBranch: "main",
        isDraft: false,
        author: "jdoe",
      }
    : null;

  let usage: RunUsage | null = null;
  let verdict: Verdict | null = null;
  let summary: string | null = null;
  let status: Run["status"] = "done";
  let errorKind: ErrorKind | null = null;
  let error: string | null = null;
  let verdictSource: Run["verdictSource"] = null;
  let reportPath: string | null = null;
  let report: string | null = null;
  let bootedByRun = false;

  if (infra) {
    // The emulator never finished booting: no device, no checks, and the runner queued a retry.
    status = "error";
    errorKind = "infra";
    error = `${device.label} did not finish booting within 120 s`;
    bootedByRun = true;
    feed.activity("info", `booting ${device.name}`);
    feed.t += 120_000;
    feed.activity("warn", error);
    feed.t += 1500;
    const next = RUN_SPECS.find((s) => s.retryOf === spec.key);
    feed.activity("info", `infrastructure failure; retrying as ${next ? "the next attempt" : "a new run"} (attempt 2)`);
  } else {
    feed.start(harness.model);
    feed.activity("info", `mobile-mcp device id: ${device.label}`);
    feed.t += 1200;
    feed.activity("info", `build under test: ${PACKAGE_ID} ${branch.versionName} (${branch.versionCode})`);

    const setupMs = durationMs * 0.1;
    const wrapMs = durationMs * 0.09;
    const checksMs = durationMs - setupMs - wrapMs - 4000;
    const stopIndex = spec.stopAt ? spec.stopAt - 1 : scenario.checks.length;
    const ctxStep: StepCtx = { device, rand };

    feed.say(`I'll confirm the device and the installed build, declare a plan of ${scenario.checks.length} checks and then work through them one by one.`);
    feed.t += 2500;
    feed.tool(
      {
        kind: "bash",
        command:
          device.platform === "android"
            ? `adb -s ${device.serial} shell dumpsys package ${PACKAGE_ID} | grep -E "versionName|versionCode"`
            : `xcrun simctl listapps ${device.serial} | grep -A6 ${PACKAGE_ID}`,
        output: `versionName=${branch.versionName}\nversionCode=${branch.versionCode}`,
      },
      1800,
    );
    feed.activity("check", `Test plan: ${scenario.checks.length} check${scenario.checks.length === 1 ? "" : "s"}`);
    for (const [i, c] of scenario.checks.entries()) {
      checks.push({ id: `C${i + 1}`, title: c.title, status: "pending", updatedAt: iso(feed.t) });
    }
    feed.t = startMs + 4000 + setupMs;

    const slice = checksMs / scenario.checks.length;
    for (const [i, c] of scenario.checks.entries()) {
      const check = checks[i]!;
      const checkStart = feed.t;
      if (i > stopIndex) break;
      const override = spec.outcomes?.[i + 1];
      const finalStatus: CheckStatus = override?.status ?? "pass";
      const note = override?.note ?? c.note;

      if (finalStatus === "skipped") {
        feed.activity("check", `${check.id}: skipped — ${note}`, { checkId: check.id, checkStatus: "skipped" });
        check.status = "skipped";
        check.note = note;
        check.endedAt = iso(feed.t);
        check.updatedAt = check.endedAt;
        feed.t = checkStart + slice * 0.15;
        continue;
      }

      feed.activity("check", `${check.id}: running`, { checkId: check.id, checkStatus: "running" });
      check.status = "running";
      check.startedAt = iso(feed.t);
      check.updatedAt = check.startedAt;
      feed.t += 600;
      feed.say(`${check.id}: ${c.title}.`);

      const calls = c.steps.flatMap((s) => stepCalls(s, ctxStep));
      const evidence =
        finalStatus === "pass" || finalStatus === "fail"
          ? `${shotPrefix}/${pad(i + 1)}-${c.screen}.png`
          : null;
      if (evidence) {
        calls.push({ call: { kind: "mcp", name: "mobile_save_screenshot", args: { device: device.label, saveTo: legacy ? evidence : path.join(runDir, evidence) }, result: `Saved screenshot to ${legacy ? evidence : path.join(runDir, evidence)}` }, weight: 1.2 });
      }
      // Device calls take seconds; the rest of the slice is the model thinking between them.
      const durations = calls.map(({ weight }) => Math.round(weight * (700 + rand() * 900)));
      const gap = Math.max(0, slice * 0.8 - durations.reduce((n, d) => n + d, 0)) / (calls.length + 1);
      feed.t += gap;
      for (const [n, { call }] of calls.entries()) {
        feed.tool(call, durations[n]!);
        feed.t += gap;
      }

      if (i === stopIndex) break;

      if (finalStatus === "fail" || finalStatus === "blocked") feed.say(`${check.id} did not pass: ${note}`);
      feed.activity("check", `${check.id}: ${finalStatus} — ${note}`, { checkId: check.id, checkStatus: finalStatus });
      check.status = finalStatus;
      check.note = note;
      check.endedAt = iso(feed.t);
      check.updatedAt = check.endedAt;
      if (evidence) {
        check.screenshot = evidence;
        screenshots.push({ rel: evidence.replace(/^qa\//, ""), screen: c.screen });
      }
      feed.t = Math.max(feed.t, checkStart + slice * 0.75);
    }

    if (spec.ending === "cancelled") {
      feed.t += 8000;
      feed.activity("info", "cancelling run");
      status = "cancelled";
      errorKind = "cancelled";
    } else if (spec.ending === "timeout") {
      feed.t = endMs - 6000;
      feed.activity("warn", `Run still running at the ${RUN_MAX_TIME} time budget; stopping it`);
      const derived = deriveVerdict(checks);
      error = `Run exceeded its time budget (${RUN_MAX_TIME})`;
      feed.activity("error", error);
      errorKind = "timeout";
      if (derived) {
        verdict = derived.verdict;
        summary = derived.summary;
        verdictSource = "derived";
      }
    } else {
      // The agent finished: report, then qa_finish.
      feed.t = Math.max(feed.t, endMs - wrapMs);
      const statuses = checks.map((c) => c.status);
      verdict = spec.verdict ?? (statuses.includes("fail") ? "FAIL" : "PASS");
      summary = spec.summary ?? "All checks passed.";
      reportPath = legacy ? `qa/QA-REPORT-${id}.md` : "report.md";
      feed.say(`All checks are resolved. Writing the report with the evidence, then I'll finish the run with ${verdict}.`);
      feed.tool({ kind: "write", path: legacy ? reportPath : path.join(runDir, reportPath) }, 1400);
      feed.t += 1200;
      feed.activity("check", `Finished: ${verdict}`);
      report = writeReport({ id, title: runTitle, device, harness: spec.harness, branch: spec.branch, branchInfo: branch, spec, checks, verdict, summary, commit, durationMs, startMs });
    }

    usage = usageFor(spec.harness, feed.toolCalls + checks.length * 2 + 2, rand);
    if (spec.ending === "cancelled") status = "cancelled";
    if (!spec.ending) feed.end(usage, summary ?? "");
  }

  const run: Run = {
    id,
    projectId: PROJECT_ID,
    title: runTitle,
    brief: scenario.brief,
    requestedBy: spec.requestedBy ?? "web",
    deviceRequest: spec.batch ? { platform: device.platform, serial: device.serial } : { platform: device.platform },
    deviceSerial: infra ? null : device.serial,
    deviceName: infra ? null : device.name,
    deviceLabel: infra ? null : device.label,
    bootedByRun,
    packageId: PACKAGE_ID,
    status,
    verdict,
    summary,
    reportPath,
    storage: legacy ? "repo" : "data",
    checks,
    error,
    createdAt: createdAt.toISOString(),
    startedAt: iso(startMs),
    endedAt: iso(endMs),
    stats: null,
    transcriptHtml: false,
    source: {
      path: ctx.repoDir,
      branch: spec.branch,
      commit,
      commitSubject: branch.commitSubject,
      dirty: false,
      remoteUrl: REMOTE_URL,
      pr: prInfo,
      prStatus: prInfo ? "found" : "none",
      tickets: spec.tickets ?? [],
      labels: { flavor: "dev" },
    },
    build: infra ? null : { packageId: PACKAGE_ID, versionName: branch.versionName, versionCode: branch.versionCode, capturedAt: iso(startMs + 5200) },
    batchId: ctx.batchId,
    suiteId: null,
    suiteChecks: null,
    harness: spec.harness,
    model: harness.model,
    thinking: spec.harness === "omp" ? harness.effort : null,
    effort: harness.effort,
    errorKind,
    verdictSource,
    usage,
    attempt: spec.retryOf ? 2 : 1,
    retryOf: spec.retryOf ? (ctx.ids.get(spec.retryOf) ?? null) : null,
    retriedBy: null,
    rerunOf: null,
    install: null,
  };
  return { run, events: feed.lines.join("\n") + "\n", report, screenshots };
}

interface ReportInput {
  id: string;
  title: string;
  device: DemoDevice;
  harness: HarnessId;
  branch: string;
  branchInfo: Branch;
  spec: RunSpec;
  checks: Check[];
  verdict: Verdict;
  summary: string;
  commit: string;
  durationMs: number;
  startMs: number;
}

const SEVERITY_BY_STATUS: Record<string, string> = { fail: "Major", blocked: "Blocker" };

function writeReport(r: ReportInput): string {
  const scenario = SCENARIOS[r.spec.scenario]!;
  const date = new Date(r.startMs);
  const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const rows = r.checks.map((c) => {
    const spec = scenario.checks[Number(c.id.slice(1)) - 1]!;
    const shot = c.screenshot ? `![${c.id} ${spec.screen}](${c.screenshot.replace(/^qa\//, "")})` : "—";
    const actual = c.note ?? "";
    return `| ${c.id} | ${c.title} | ${spec.note.replace(/\|/g, "/")} | ${actual.replace(/\|/g, "/")} | ${STATUS_ICON[c.status] ?? c.status} | ${shot} |`;
  });
  const failures = r.checks.filter((c) => c.status === "fail" || c.status === "blocked");
  const bugs = failures.length
    ? failures
        .map((c, i) => {
          const spec = scenario.checks[Number(c.id.slice(1)) - 1]!;
          const steps = spec.steps.filter((s) => s !== "launch").map((s, n) => `${n + 1}. ${describeStep(s)}`);
          return [
            `### ${i + 1}. ${c.title}`,
            "",
            `**Severity:** ${c.status === "blocked" ? "Blocker" : (SEVERITY_BY_STATUS[c.status] ?? "Minor")}`,
            "",
            "**Steps to reproduce**",
            "",
            steps.length ? steps.join("\n") : "1. Launch the app from a fresh state.",
            "",
            `**Expected:** ${spec.note}`,
            "",
            `**Actual:** ${c.note}`,
            "",
            c.screenshot ? `![${c.id} evidence](${c.screenshot.replace(/^qa\//, "")})` : "",
          ].join("\n");
        })
        .join("\n\n")
    : "No defects found.";
  const ticketLine = (r.spec.tickets ?? []).join(", ") || "not provided";
  const prLine = r.spec.pr ? `#${r.spec.pr.number} — ${r.spec.pr.title}` : "not provided";
  const minutes = (r.durationMs / MIN).toFixed(1);
  return [
    `# QA report: ${r.title}`,
    "",
    "| | |",
    "|---|---|",
    `| Date | ${when} |`,
    `| App | Acme Shop (\`${PACKAGE_ID}\`) ${r.branchInfo.versionName} (${r.branchInfo.versionCode}) |`,
    `| Device | ${r.device.name}, ${r.device.osVersion}, \`${r.device.serial}\`, ${r.device.screen} |`,
    `| Driver | mobile-mcp (${r.harness}) |`,
    `| Branch | \`${r.branch}\` |`,
    `| Commit | \`${r.commit.slice(0, 9)}\` ${r.branchInfo.commitSubject} |`,
    `| Pull request | ${prLine} |`,
    `| Tickets | ${ticketLine} |`,
    "",
    "## Executive summary",
    "",
    `**Verdict: ${r.verdict}**`,
    "",
    r.summary,
    "",
    "## Checks",
    "",
    "| ID | Check | Expected | Actual | Status | Evidence |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Bugs found",
    "",
    bugs,
    "",
    "## Environment and limitations",
    "",
    `- Ran on ${r.device.name} (${r.device.osVersion}), a local ${r.device.platform === "android" ? "emulator" : "simulator"}; no physical hardware was available.`,
    "- No device-global settings were changed that were not restored.",
    "",
    "## Cost note",
    "",
    `${r.checks.filter((c) => c.status !== "skipped").length} of ${r.checks.length} checks executed in ${minutes} minutes.`,
    "",
  ].join("\n");
}

function describeStep(step: string): string {
  const [verb = "", ...rest] = step.split(":");
  const arg = rest.join(":");
  switch (verb) {
    case "tap":
      return `Tap “${arg}”.`;
    case "type":
      return `Type “${arg}”.`;
    case "swipe":
      return `Swipe ${arg}.`;
    case "open":
      return `Open ${arg}.`;
    case "restart":
      return "Force-stop and relaunch the app.";
    case "back":
      return "Go back.";
    case "reset":
      return "Clear the app data.";
    default:
      return `Run \`${arg || verb}\`.`;
  }
}

export interface SeedOptions {
  dataDir: string;
  configFile: string;
  /** Throwaway git repo the project points at; holds `qa/` (report and screenshots) only for the two legacy runs. */
  repoDir: string;
  now?: Date;
}

export interface SeedResult extends SeedOptions {
  runIds: string[];
}

function git(repoDir: string, args: string[]): void {
  const proc = Bun.spawnSync([process.env.GIT_BIN ?? "git", "-C", repoDir, "-c", "user.name=Acme Dev", "-c", "user.email=dev@acme.example", "-c", "commit.gpgsign=false", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${proc.stderr.toString().trim()}`);
}

function initRepo(repoDir: string): void {
  if (existsSync(path.join(repoDir, ".git"))) return;
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, "README.md"), "# Acme Shop\n\nFictional demo app used to seed Tapocalypse screenshots.\n");
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "Initial commit"]);
}

/** Writes the demo config, the git repo with its reports and the data dir with every run. */
export function seedDemo(opts: SeedOptions): SeedResult {
  const { dataDir, configFile, repoDir } = opts;
  const runsDir = path.join(dataDir, "runs");
  if (existsSync(runsDir) && readdirSync(runsDir).length > 0) {
    throw new Error(`${dataDir} already has runs; refusing to seed into it. Pass a fresh --dir.`);
  }
  const now = (opts.now ?? new Date()).getTime();

  initRepo(repoDir);
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        port: 4320,
        maxConcurrentRuns: 2,
        runMaxTime: RUN_MAX_TIME,
        projects: [
          { id: PROJECT_ID, name: "Acme Shop", repoPath: repoDir, defaultPackage: PACKAGE_ID, defaultPlatform: "android" },
        ],
        retry: { infra: 1 },
        devicePool: {
          android: { avds: [], basePort: 5560, maxBooted: 1, minSize: "720x1280", minDensity: 320, idleShutdownMinutes: 20, excludeSerials: [] },
          ios: { simulators: [], idleShutdownMinutes: 20 },
        },
      },
      null,
      2,
    )}\n`,
  );

  const persona = readFileSync(PERSONA_FILE, "utf8");
  const ids = new Map<string, string>();
  const runIds: string[] = [];
  const built: Finished[] = [];
  const batchRuns: Run[] = [];
  let batchId: string | null = null;

  for (const [index, spec] of RUN_SPECS.entries()) {
    if (spec.batch && !batchId) {
      const first = new Date(now - spec.agoMin * MIN - 30_000);
      batchId = `b-${stamp(first)}-${sha("onboarding-batch").slice(0, 4)}`;
    }
    const finished = buildRun(spec, { now, repoDir, dataDir, index, ids, batchId: spec.batch ? batchId : null });
    if (spec.key) ids.set(spec.key, finished.run.id);
    built.push(finished);
    runIds.push(finished.run.id);
    if (spec.batch) batchRuns.push(finished.run);
  }
  // Infra retries link both ways; the failed attempt is judged by its successor.
  for (const { run } of built) {
    if (!run.retryOf) continue;
    const failed = built.find((b) => b.run.id === run.retryOf);
    if (failed) failed.run.retriedBy = run.id;
  }

  for (const { run, events, report, screenshots } of built) {
    const dir = path.join(runsDir, run.id);
    mkdirSync(path.join(dir, "session"), { recursive: true });
    writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
    writeFileSync(path.join(dir, "brief.md"), run.brief);
    writeFileSync(path.join(dir, "persona.md"), persona);
    writeFileSync(path.join(dir, "events.jsonl"), events);
    // Data runs keep their artefacts in the run dir; legacy runs in the repo's `qa/` folder.
    const artefactRoot = run.storage === "repo" ? path.join(repoDir, "qa") : dir;
    for (const shot of screenshots) {
      const target = path.join(artefactRoot, shot.rel);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(SCREENS_DIR, `${shot.screen}.png`), target);
    }
    if (report && run.reportPath) {
      const file = run.storage === "repo" ? path.join(repoDir, run.reportPath) : path.join(dir, run.reportPath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, report);
      // Report lists sort by mtime: keep them in run order.
      const ended = new Date(run.endedAt ?? run.createdAt);
      utimesSync(file, ended, ended);
    }
  }

  if (batchId && batchRuns.length > 0) {
    mkdirSync(path.join(dataDir, "batches"), { recursive: true });
    const title = SCENARIOS.onboarding!.title;
    const createdAt = batchRuns.map((r) => r.createdAt).sort()[0]!;
    writeFileSync(path.join(dataDir, "batches", `${batchId}.json`), JSON.stringify({ id: batchId, projectId: PROJECT_ID, title, createdAt }, null, 2));
  }

  return { ...opts, runIds };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dir: { type: "string" }, config: { type: "string" }, repo: { type: "string" } }, strict: true });
  const dataDir = path.resolve(values.dir ?? mkdtempSync(path.join(os.tmpdir(), "tapocalypse-demo-")));
  const configFile = path.resolve(values.config ?? path.join(dataDir, "config.json"));
  const repoDir = path.resolve(values.repo ?? path.join(dataDir, "acme-shop"));
  try {
    const result = seedDemo({ dataDir, configFile, repoDir });
    console.log(`Seeded ${result.runIds.length} demo runs for "Acme Shop".`);
    console.log(`  data dir: ${dataDir}`);
    console.log(`  config:   ${configFile}`);
    console.log(`  repo:     ${repoDir}`);
    console.log("");
    console.log("Serve it on a spare port:");
    console.log(`  TAPOCALYPSE_PORT=4320 TAPOCALYPSE_CONFIG=${configFile} TAPOCALYPSE_DATA_DIR=${dataDir} NODE_ENV=production bun src/server.ts`);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
