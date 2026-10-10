#!/usr/bin/env bun
// Command line entry: `tapocalypse serve | service | doctor | run | status | report`.
// Everything except `serve`/`service`/`doctor` talks to a running server over HTTP. This module must not import config
// (or anything that does) at load time: the config reads TAPOCALYPSE_PORT when first imported, and `--help`
// has to work without a config file.
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { HARNESS_IDS, type HarnessId } from "./harness/types";
import type { ServiceAction } from "./service";
import { VERDICTS, type CheckStatus, type RunStatus, type Verdict } from "./runs/types";

export const EXIT = { OK: 0, VERDICT: 1, ERROR: 2, USAGE: 3 } as const;

const DEFAULT_PORT = 4310;
const DEFAULT_TIMEOUT = "90m";
const DEFAULT_FAIL_ON: Verdict[] = ["FAIL", "BLOCKED", "PARTIAL"];
const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BATCH_DEVICES = 8;
const TERMINAL: RunStatus[] = ["done", "error", "cancelled", "interrupted"];

export class UsageError extends Error {}

export class ServerUnreachableError extends Error {
  constructor(readonly baseUrl: string) {
    super(
      `cannot reach Tapocalypse at ${baseUrl}. Start it with \`tapocalypse service start\` (the always-on service; \`tapocalypse service install\` sets it up once), \`tapocalypse serve\` or \`bun start\` in the Tapocalypse checkout, or point --url at a running instance.`,
    );
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Argument parsing

export interface RunOptions {
  projectId: string;
  brief: string | null;
  briefFile: string | null;
  suiteId: string | null;
  title: string | null;
  platform: "android" | "ios" | null;
  serials: string[];
  devices: number | null;
  harness: HarnessId | null;
  model: string | null;
  install: string | null;
  wait: boolean;
  timeoutMs: number;
  json: boolean;
  junit: string | null;
  failOn: Verdict[];
  url: string;
}

export type Command =
  | { name: "help" }
  | { name: "version" }
  | { name: "serve"; port: number | null; dev: boolean }
  | { name: "doctor" }
  | { name: "run"; options: RunOptions }
  | { name: "status"; id: string; json: boolean; url: string }
  | { name: "report"; id: string; exportDir: string | null; json: boolean; url: string }
  | { name: "service"; action: ServiceAction };

const SERVICE_ACTIONS = ["install", "uninstall", "start", "stop", "restart", "status", "logs"] as const satisfies readonly ServiceAction[];

export const USAGE = `tapocalypse - parallel, agent-driven QA runs on Android emulators and iOS simulators

Usage:
  tapocalypse serve [--port <n>] [--dev]
      Start the server and web UI (same as \`bun start\`). --dev enables Bun's development server (HMR, console forwarding).
  tapocalypse doctor
      Check prerequisites; exits 1 when a required one is missing.
  tapocalypse run --project <id> (--brief <text> | --brief-file <file|-> | --suite <id>) [options]
      Start a QA run (or a batch) on a running server.
  tapocalypse status <runId|batchId> [--json] [--url <url>]
      Show the state of a run or batch, including the absolute path of its report.
  tapocalypse report <runId> [--export <dir>] [--json] [--url <url>]
      Print a run's markdown report. Reports and screenshots live in Tapocalypse's data dir, not in your repository;
      --export copies them (QA-REPORT-<runId>.md + screenshots/) into <dir>. --json prints { runId, reportPath, markdown }.
  tapocalypse service ${SERVICE_ACTIONS.join("|")}
      Manage the always-on background service (launchd on macOS, a systemd user unit on Linux) that keeps the server running.

Run options:
  --project <id>        Project id (see the Projects page)
  --brief <text>        What to test, in plain language
  --brief-file <file>   Read the brief from a file ("-" = stdin)
  --suite <id>          Use a saved suite from <repo>/.tapocalypse/suites/<id>.md
  --title <text>        Run title (default: first line of the brief / the suite title)
  --platform <p>        android | ios (default: the device's platform, else the project's default)
  --serial <serial>     Run on this device; repeat for one run per device (a batch)
  --devices <n>         Fan out to n devices of the platform (a batch, 1-${MAX_BATCH_DEVICES})
  --harness <id>        Agent harness: ${HARNESS_IDS.join(" | ")} (default: project / persona / config, else the first installed)
  --model <model>       Harness-native model for the agent (default: suite / persona / config)
  --install <path>      Install this .apk / .app / .ipa on the device before the run (single run only)
  --wait                Wait for the run(s) to finish; progress goes to stderr
  --timeout <dur>       Stop waiting after this long (default ${DEFAULT_TIMEOUT}; e.g. 30s, 45m, 2h); only used with --wait
  --json                Print JSON to stdout instead of text
  --junit <file>        Write a JUnit XML report (implies --wait)
  --fail-on <list>      Verdicts that make the exit code 1 (default ${DEFAULT_FAIL_ON.join(",")})
  --url <url>           Server URL (default $TAPOCALYPSE_URL, else http://127.0.0.1:${DEFAULT_PORT})

Exit codes:
  0  success                    1  a verdict is in --fail-on
  2  run error, timeout, infra  3  usage error or server unreachable
`;

function tokenize<const T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text.trim());
  if (!m) throw new UsageError(`invalid duration "${text}" (examples: 30s, 45m, 2h)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"] as number;
  const ms = Math.round(Number(m[1]) * unit);
  if (ms <= 0) throw new UsageError(`invalid duration "${text}": must be positive`);
  return ms;
}

export function parseFailOn(text: string): Verdict[] {
  const out: Verdict[] = [];
  for (const part of text.split(",")) {
    const v = part.trim().toUpperCase().replace(/[_-]+/g, " ");
    if (!v) continue;
    const verdict = VERDICTS.find((x) => x === v);
    if (!verdict) throw new UsageError(`unknown verdict "${part.trim()}" in --fail-on (one of ${VERDICTS.join(", ")})`);
    if (!out.includes(verdict)) out.push(verdict);
  }
  return out;
}

function baseUrl(flag: string | undefined, env: Record<string, string | undefined>): string {
  const raw = flag ?? env.TAPOCALYPSE_URL ?? `http://127.0.0.1:${env.TAPOCALYPSE_PORT ?? DEFAULT_PORT}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`invalid --url "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UsageError(`invalid --url "${raw}"`);
  return url.origin;
}

function parsePort(text: string): number {
  const port = Number(text);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new UsageError(`invalid --port "${text}"`);
  return port;
}

export function parseCli(argv: string[], env: Record<string, string | undefined> = {}): Command {
  const [first, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h") return { name: "help" };
  if (first === "--version" || first === "-v") return { name: "version" };
  if (rest.includes("--help") || rest.includes("-h")) return { name: "help" };

  switch (first) {
    case "serve": {
      const { values, positionals } = tokenize(rest, { port: { type: "string" }, dev: { type: "boolean" } });
      if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
      return { name: "serve", port: values.port === undefined ? null : parsePort(values.port), dev: values.dev === true };
    }
    case "doctor": {
      const { positionals } = tokenize(rest, {});
      if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
      return { name: "doctor" };
    }
    case "status": {
      const { values, positionals } = tokenize(rest, { json: { type: "boolean" }, url: { type: "string" } });
      if (positionals.length !== 1) throw new UsageError("usage: tapocalypse status <runId|batchId> [--json] [--url <url>]");
      return { name: "status", id: positionals[0]!, json: values.json === true, url: baseUrl(values.url, env) };
    }
    case "report": {
      const { values, positionals } = tokenize(rest, { export: { type: "string" }, json: { type: "boolean" }, url: { type: "string" } });
      if (positionals.length !== 1) throw new UsageError("usage: tapocalypse report <runId> [--export <dir>] [--json] [--url <url>]");
      return {
        name: "report",
        id: positionals[0]!,
        exportDir: values.export === undefined ? null : path.resolve(values.export),
        json: values.json === true,
        url: baseUrl(values.url, env),
      };
    }
    case "service": {
      const { positionals } = tokenize(rest, {});
      const action = SERVICE_ACTIONS.find((a) => a === positionals[0]);
      if (positionals.length !== 1 || !action) throw new UsageError(`usage: tapocalypse service <${SERVICE_ACTIONS.join("|")}>`);
      return { name: "service", action };
    }
    case "run":
      return { name: "run", options: parseRunOptions(rest, env) };
    default:
      throw new UsageError(`unknown command "${first}"`);
  }
}

function parseRunOptions(args: string[], env: Record<string, string | undefined>): RunOptions {
  const { values, positionals } = tokenize(args, {
    project: { type: "string" },
    brief: { type: "string" },
    "brief-file": { type: "string" },
    suite: { type: "string" },
    title: { type: "string" },
    platform: { type: "string" },
    serial: { type: "string", multiple: true },
    devices: { type: "string" },
    harness: { type: "string" },
    model: { type: "string" },
    install: { type: "string" },
    wait: { type: "boolean" },
    timeout: { type: "string" },
    json: { type: "boolean" },
    junit: { type: "string" },
    "fail-on": { type: "string" },
    url: { type: "string" },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  if (!values.project) throw new UsageError("--project is required");
  const sources = [values.brief, values["brief-file"], values.suite].filter((v) => v !== undefined);
  if (sources.length !== 1) throw new UsageError("pass exactly one of --brief, --brief-file or --suite");
  if (values.brief !== undefined && !values.brief.trim()) throw new UsageError("--brief must not be empty");

  const platform = values.platform ?? null;
  if (platform !== null && platform !== "android" && platform !== "ios") {
    throw new UsageError(`invalid --platform "${platform}" (android or ios)`);
  }
  const serials = values.serial ?? [];
  if (new Set(serials).size !== serials.length) throw new UsageError("--serial given twice for the same device");

  let devices: number | null = null;
  if (values.devices !== undefined) {
    devices = Number(values.devices);
    if (!Number.isInteger(devices) || devices < 1 || devices > MAX_BATCH_DEVICES) {
      throw new UsageError(`--devices must be a whole number from 1 to ${MAX_BATCH_DEVICES}`);
    }
    if (serials.length > 0) throw new UsageError("use either --serial or --devices, not both");
  }
  if (serials.length > MAX_BATCH_DEVICES) throw new UsageError(`at most ${MAX_BATCH_DEVICES} devices per batch`);
  const fanOut = serials.length > 1 || (devices ?? 1) > 1;
  if (fanOut && values.install !== undefined) throw new UsageError("--install is only supported for a single device");

  const harness = HARNESS_IDS.find((id) => id === values.harness) ?? null;
  if (values.harness !== undefined && harness === null) {
    throw new UsageError(`invalid --harness "${values.harness}" (${HARNESS_IDS.join(", ")})`);
  }

  const junit = values.junit ?? null;
  return {
    projectId: values.project,
    brief: values.brief ?? null,
    briefFile: values["brief-file"] ?? null,
    suiteId: values.suite ?? null,
    title: values.title?.trim() || null,
    platform,
    serials,
    devices,
    harness,
    model: values.model ?? null,
    install: values.install ?? null,
    wait: values.wait === true || junit !== null,
    timeoutMs: parseDuration(values.timeout ?? DEFAULT_TIMEOUT),
    json: values.json === true,
    junit,
    failOn: values["fail-on"] === undefined ? DEFAULT_FAIL_ON : parseFailOn(values["fail-on"]),
    url: baseUrl(values.url, env),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Run/batch views as the server returns them (only the fields the CLI reads)

export interface CheckLite {
  id: string;
  title: string;
  status: CheckStatus;
  note?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface RunLite {
  id: string;
  projectId: string;
  title: string;
  status: RunStatus;
  verdict: Verdict | null;
  verdictSource?: "agent" | "derived" | null;
  summary: string | null;
  error: string | null;
  errorKind?: "infra" | "agent" | "timeout" | "cancelled" | null;
  deviceSerial: string | null;
  checks: CheckLite[];
  startedAt: string | null;
  endedAt: string | null;
  /** Absolute path of the run's report (additive, from `GET /api/runs/:id`); null when it has none. */
  reportFile?: string | null;
  batchId?: string | null;
  retriedBy?: string | null;
  queuePosition?: number | null;
}

export interface BatchLite {
  id: string;
  title: string;
  runs: RunLite[];
}

export const isTerminal = (run: RunLite): boolean => TERMINAL.includes(run.status);

// ---------------------------------------------------------------------------------------------------------------
// Request building

type Platform = "android" | "ios";

export interface StartRequest {
  kind: "run" | "batch";
  path: string;
  body: Record<string, unknown>;
}

/** Title for runs started without --title: the suite id, else the first non-empty brief line, clipped. */
export function defaultTitle(options: Pick<RunOptions, "suiteId">, brief: string | null): string | undefined {
  if (options.suiteId) return undefined;
  const line = (brief ?? "").split("\n").find((l) => l.trim())?.trim() ?? "QA run";
  const clean = line.replace(/^#+\s*/, "");
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

export function buildStartRequest(
  options: RunOptions,
  brief: string | null,
  platformFor: (serial: string | null) => Platform,
  requestedBy: string,
): StartRequest {
  const common: Record<string, unknown> = {
    projectId: options.projectId,
    requestedBy,
    ...(options.suiteId ? { suiteId: options.suiteId } : { brief }),
    ...(options.harness ? { harness: options.harness } : {}),
    ...(options.model ? { model: options.model } : {}),
  };
  const title = options.title ?? defaultTitle(options, brief);
  if (title) common.title = title;

  const fanOut = options.serials.length > 1 || (options.devices ?? 1) > 1;
  if (!fanOut) {
    const serial = options.serials[0] ?? null;
    const platform = options.platform ?? platformFor(serial);
    return {
      kind: "run",
      path: "/api/runs",
      body: {
        ...common,
        device: { platform, ...(serial ? { serial } : {}) },
        ...(options.install ? { install: { path: options.install } } : {}),
      },
    };
  }
  const devices =
    options.serials.length > 1
      ? options.serials.map((serial) => ({ platform: options.platform ?? platformFor(serial), serial }))
      : Array.from({ length: options.devices ?? 1 }, () => ({ platform: options.platform ?? platformFor(null) }));
  return { kind: "batch", path: "/api/batches", body: { ...common, devices } };
}

// ---------------------------------------------------------------------------------------------------------------
// Exit codes

/** 0 ok, 1 verdict in fail-on, 2 error / timeout / infra / no verdict. */
export function exitCodeForRun(run: RunLite, failOn: Verdict[]): number {
  if (run.errorKind === "timeout" || run.errorKind === "infra") return EXIT.ERROR;
  if (run.status !== "done" || run.verdict === null) return EXIT.ERROR;
  return failOn.includes(run.verdict) ? EXIT.VERDICT : EXIT.OK;
}

/** Worst code across runs (2 > 1 > 0); a wait that timed out is always 2. */
export function exitCodeForRuns(runs: RunLite[], failOn: Verdict[], timedOut: boolean): number {
  if (timedOut || runs.length === 0) return EXIT.ERROR;
  return Math.max(...runs.map((r) => exitCodeForRun(r, failOn)));
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof UsageError || error instanceof ServerUnreachableError) return EXIT.USAGE;
  if (error instanceof ApiError) return error.status >= 400 && error.status < 500 ? EXIT.USAGE : EXIT.ERROR;
  return EXIT.ERROR;
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// Run text is written by agents that read arbitrary on-screen content, so it is untrusted terminal input.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
const TERMINAL_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;

/**
 * One safe line of untrusted text: control characters (ESC sequences, BEL, CR...) and newlines become a space.
 * A single line that is always printed after a prefix can never start a `::error::` workflow command or overwrite earlier output.
 */
export function oneLine(text: string): string {
  return text.replace(TERMINAL_CONTROLS, " ").replace(/ {2,}/g, " ").trim();
}

const RESOLVED: CheckStatus[] = ["pass", "fail", "blocked", "skipped"];

function resolvedCount(run: RunLite): number {
  return run.checks.filter((c) => RESOLVED.includes(c.status)).length;
}

export function progressLine(run: RunLite): string {
  const parts = [`[${oneLine(run.title)}] ${run.status}`];
  if (run.status === "queued" && run.queuePosition) parts.push(`queue #${run.queuePosition}`);
  if (run.deviceSerial) parts.push(oneLine(run.deviceSerial));
  if (run.checks.length > 0) {
    parts.push(`${resolvedCount(run)}/${run.checks.length} checks`);
    const running = run.checks.find((c) => c.status === "running");
    if (running) parts.push(`${running.id} running`);
  }
  if (isTerminal(run) && run.verdict) parts.push(run.verdict);
  return parts.join(" · ");
}

function runDurationMs(run: RunLite): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function runUrl(base: string, id: string): string {
  return `${base}/#/runs/${id}`;
}

export function formatRun(run: RunLite, base: string): string {
  const head = run.verdict ?? run.status.toUpperCase();
  const dur = runDurationMs(run);
  const meta = [
    run.deviceSerial && oneLine(run.deviceSerial),
    run.checks.length > 0 ? `${resolvedCount(run)}/${run.checks.length} checks` : null,
    dur === null ? null : formatDuration(dur),
  ].filter((x): x is string => Boolean(x));
  const lines = [`${head}  ${oneLine(run.title)}${meta.length ? ` (${meta.join(" · ")})` : ""}`];
  if (run.verdictSource === "derived") lines.push("  verdict derived from the checks: the agent did not report one");
  if (run.summary) lines.push(`  ${oneLine(run.summary)}`);
  if (run.error && (run.status !== "done" || run.verdictSource === "derived")) lines.push(`  error${run.errorKind ? ` (${run.errorKind})` : ""}: ${oneLine(run.error)}`);
  for (const c of run.checks) {
    if (c.status === "fail" || c.status === "blocked") lines.push(`  ${c.status.toUpperCase()} ${oneLine(c.id)} ${oneLine(c.title)}${c.note ? `: ${oneLine(c.note)}` : ""}`);
  }
  if (run.reportFile) lines.push(`  report: ${oneLine(run.reportFile)}`);
  lines.push(`  ${runUrl(base, run.id)} (run ${run.id})`);
  return lines.join("\n");
}

export function summarizeRun(run: RunLite, base: string) {
  return {
    runId: run.id,
    title: run.title,
    projectId: run.projectId,
    status: run.status,
    verdict: run.verdict,
    verdictSource: run.verdictSource ?? null,
    summary: run.summary,
    error: run.error,
    errorKind: run.errorKind ?? null,
    deviceSerial: run.deviceSerial,
    reportPath: run.reportFile ?? null,
    durationMs: runDurationMs(run),
    checks: run.checks.map((c) => ({ id: c.id, title: c.title, status: c.status, note: c.note ?? null })),
    url: runUrl(base, run.id),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JUnit

// XML 1.0 forbids most control characters even as numeric references, so they are dropped.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function xmlEscape(text: string): string {
  return text
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
}

/** Element text content: like attributes but newlines stay literal. */
function xmlText(text: string): string {
  return text.replace(XML_INVALID, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function seconds(ms: number | null): string {
  return ((ms ?? 0) / 1000).toFixed(3);
}

function checkMs(c: CheckLite): number | null {
  if (!c.startedAt || !c.endedAt) return null;
  const ms = Date.parse(c.endedAt) - Date.parse(c.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

interface JUnitCase {
  name: string;
  timeMs: number | null;
  outcome: { kind: "pass" } | { kind: "failure" | "error" | "skipped"; message: string; detail?: string };
}

function casesFor(run: RunLite): JUnitCase[] {
  const ended = isTerminal(run);
  const cases: JUnitCase[] = run.checks.map((c): JUnitCase => {
    const name = `${c.id}: ${c.title}`;
    const timeMs = checkMs(c);
    switch (c.status) {
      case "pass":
        return { name, timeMs, outcome: { kind: "pass" } };
      case "fail":
        return { name, timeMs, outcome: { kind: "failure", message: c.note ?? "check failed", detail: c.note } };
      case "skipped":
        return { name, timeMs, outcome: { kind: "skipped", message: c.note ? `skipped: ${c.note}` : "skipped" } };
      case "blocked":
        return { name, timeMs, outcome: { kind: "skipped", message: c.note ? `blocked: ${c.note}` : "blocked" } };
      default:
        return {
          name,
          timeMs,
          outcome: { kind: "skipped", message: ended ? `not completed (${c.status})` : `still ${c.status}` },
        };
    }
  });
  const failedChecks = run.checks.some((c) => c.status === "fail");
  if (run.verdict === "FAIL" && !failedChecks) {
    cases.push({
      name: "verdict",
      timeMs: null,
      outcome: { kind: "failure", message: "verdict FAIL", detail: run.summary ?? undefined },
    });
  }
  const errored =
    run.status === "error" ||
    run.status === "cancelled" ||
    run.status === "interrupted" ||
    run.errorKind === "timeout" ||
    run.errorKind === "infra";
  if (errored) {
    cases.push({
      name: "run",
      timeMs: null,
      outcome: { kind: "error", message: run.error ?? `run ${run.status}`, detail: run.error ?? undefined },
    });
  } else if (!ended) {
    cases.push({ name: "run", timeMs: null, outcome: { kind: "error", message: `run still ${run.status}` } });
  }
  return cases;
}

export function renderJUnit(runs: RunLite[], base: string): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const suites = runs.map((run) => ({ run, cases: casesFor(run) }));
  const count = (kinds: string[]) =>
    suites.reduce((n, s) => n + s.cases.filter((c) => kinds.includes(c.outcome.kind)).length, 0);
  const total = suites.reduce((n, s) => n + s.cases.length, 0);
  const totalMs = suites.reduce((n, s) => n + (runDurationMs(s.run) ?? 0), 0);
  out.push(
    `<testsuites name="tapocalypse" tests="${total}" failures="${count(["failure"])}" errors="${count(["error"])}" skipped="${count(["skipped"])}" time="${seconds(totalMs)}">`,
  );
  for (const { run, cases } of suites) {
    const n = (kind: string) => cases.filter((c) => c.outcome.kind === kind).length;
    const attrs = [
      `name="${xmlEscape(run.title)}"`,
      `tests="${cases.length}"`,
      `failures="${n("failure")}"`,
      `errors="${n("error")}"`,
      `skipped="${n("skipped")}"`,
      `time="${seconds(runDurationMs(run))}"`,
    ];
    if (run.startedAt) attrs.push(`timestamp="${xmlEscape(run.startedAt)}"`);
    out.push(`  <testsuite ${attrs.join(" ")}>`);
    out.push("    <properties>");
    const props: [string, string | null | undefined][] = [
      ["run.id", run.id],
      ["run.url", runUrl(base, run.id)],
      ["project", run.projectId],
      ["status", run.status],
      ["verdict", run.verdict],
      ["verdict.source", run.verdictSource],
      ["device", run.deviceSerial],
      ["batch", run.batchId],
      ["report", run.reportFile],
    ];
    for (const [name, value] of props) if (value) out.push(`      <property name="${name}" value="${xmlEscape(value)}"/>`);
    out.push("    </properties>");
    for (const c of cases) {
      const open = `    <testcase classname="${xmlEscape(run.title)}" name="${xmlEscape(c.name)}" time="${seconds(c.timeMs)}"`;
      const o = c.outcome;
      if (o.kind === "pass") out.push(`${open}/>`);
      else if (o.kind === "skipped") out.push(`${open}><skipped message="${xmlEscape(o.message)}"/></testcase>`);
      else out.push(`${open}><${o.kind} message="${xmlEscape(o.message)}">${xmlText(o.detail ?? o.message)}</${o.kind}></testcase>`);
    }
    const log = [run.summary, run.error && (run.status !== "done" || run.verdictSource === "derived") ? `error: ${run.error}` : null].filter(Boolean).join("\n");
    if (log) out.push(`    <system-out>${xmlText(log)}</system-out>`);
    out.push("  </testsuite>");
  }
  out.push("</testsuites>", "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP client + waiting

export class ApiClient {
  constructor(
    readonly base: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request<T>(method: "GET" | "POST", pathname: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ServerUnreachableError(this.base);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body: fall through to the status text
    }
    if (!res.ok) {
      const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : text || res.statusText;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }
}

export interface WaitDeps {
  /** Current state of everything being waited on (the run, or all runs of the batch). */
  snapshot(): Promise<RunLite[]>;
  fetchRun(id: string): Promise<RunLite>;
  sleep(ms: number): Promise<void>;
  now(): number;
  onProgress(line: string): void;
}

/** Replaces a run superseded by an infra auto-retry with its final successor. */
async function followRetries(runs: RunLite[], fetchRun: (id: string) => Promise<RunLite>): Promise<RunLite[]> {
  const seen = new Set<string>();
  const out: RunLite[] = [];
  for (let run of runs) {
    for (let hops = 0; run.retriedBy && hops < 10; hops++) run = await fetchRun(run.retriedBy);
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    out.push(run);
  }
  return out;
}

export async function waitForRuns(deps: WaitDeps, opts: { timeoutMs: number; pollMs: number }): Promise<{ runs: RunLite[]; timedOut: boolean }> {
  const deadline = deps.now() + opts.timeoutMs;
  const lastLine = new Map<string, string>();
  for (;;) {
    const runs = await followRetries(await deps.snapshot(), deps.fetchRun);
    for (const run of runs) {
      const line = progressLine(run);
      if (lastLine.get(run.id) !== line) {
        lastLine.set(run.id, line);
        deps.onProgress(line);
      }
    }
    if (runs.length > 0 && runs.every(isTerminal)) return { runs, timedOut: false };
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { runs, timedOut: true };
    await deps.sleep(Math.min(opts.pollMs, remaining));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Command execution

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const consoleIo: Io = { out: (t) => console.log(t), err: (t) => console.error(t) };

async function readBrief(options: RunOptions): Promise<string | null> {
  if (options.briefFile === null) return options.brief;
  const text = options.briefFile === "-" ? await Bun.stdin.text() : await readFileOrUsage(options.briefFile);
  if (!text.trim()) throw new UsageError(`brief file ${options.briefFile} is empty`);
  return text;
}

async function readFileOrUsage(file: string): Promise<string> {
  try {
    return await Bun.file(file).text();
  } catch {
    throw new UsageError(`cannot read brief file ${file}`);
  }
}

interface ProjectLite {
  id: string;
  defaultPlatform: Platform;
}
interface DeviceLite {
  serial: string;
  platform: Platform;
}

async function platformResolver(api: ApiClient, options: RunOptions): Promise<(serial: string | null) => Platform> {
  const projects = await api.request<ProjectLite[]>("GET", "/api/projects");
  const project = projects.find((p) => p.id === options.projectId);
  if (!project) {
    throw new UsageError(`unknown project "${options.projectId}" (known: ${projects.map((p) => p.id).join(", ") || "none"})`);
  }
  let devices: DeviceLite[] = [];
  if (options.serials.length > 0 && options.platform === null) {
    devices = await api.request<DeviceLite[]>("GET", "/api/devices");
  }
  return (serial) => devices.find((d) => d.serial === serial)?.platform ?? project.defaultPlatform;
}

function requester(env: Record<string, string | undefined>): string {
  return env.GITHUB_ACTIONS ? "github-actions" : env.CI ? "ci" : "cli";
}

export interface RunDeps {
  api: ApiClient;
  io: Io;
  env: Record<string, string | undefined>;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  writeFile: (file: string, text: string) => Promise<void>;
}

export function defaultRunDeps(base: string, env: Record<string, string | undefined> = process.env): RunDeps {
  return {
    api: new ApiClient(base),
    io: consoleIo,
    env,
    pollMs: POLL_MS,
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    writeFile: async (file, text) => {
      await Bun.write(file, text);
    },
  };
}

/** `tapocalypse run`: returns the process exit code. */
export async function executeRun(options: RunOptions, deps: RunDeps): Promise<number> {
  const { api, io } = deps;
  const brief = await readBrief(options);
  const install = options.install ? path.resolve(options.install) : null;
  if (install && !existsSync(install)) throw new UsageError(`--install path not found: ${install}`);
  const platformFor = await platformResolver(api, options);
  const request = buildStartRequest({ ...options, install }, brief, platformFor, requester(deps.env));

  let ids: string[];
  let batchId: string | null = null;
  let started: RunLite[];
  if (request.kind === "batch") {
    const res = await api.request<{ batchId: string; runs: RunLite[] }>("POST", request.path, request.body);
    batchId = res.batchId;
    started = res.runs;
    ids = res.runs.map((r) => r.id);
    io.err(`started batch ${batchId} with ${ids.length} runs: ${api.base}/#/batches/${batchId}`);
  } else {
    const run = await api.request<RunLite>("POST", request.path, request.body);
    started = [run];
    ids = [run.id];
    io.err(`started run ${run.id}: ${runUrl(api.base, run.id)}`);
  }

  if (!options.wait) {
    if (options.json) {
      io.out(JSON.stringify({ batchId, runs: started.map((r) => summarizeRun(r, api.base)) }, null, 2));
    } else {
      for (const r of started) io.out(`${r.id}  ${r.status}  ${runUrl(api.base, r.id)}`);
    }
    return EXIT.OK;
  }

  const { runs, timedOut } = await waitForRuns(
    {
      snapshot: async () =>
        batchId
          ? (await api.request<BatchLite>("GET", `/api/batches/${batchId}`)).runs
          : [await api.request<RunLite>("GET", `/api/runs/${ids[0]}`)],
      fetchRun: (id) => api.request<RunLite>("GET", `/api/runs/${id}`),
      sleep: deps.sleep,
      now: deps.now,
      onProgress: io.err,
    },
    { timeoutMs: options.timeoutMs, pollMs: deps.pollMs },
  );
  if (timedOut) {
    io.err(`timed out waiting after ${formatDuration(options.timeoutMs)}; the run(s) keep going on the server (cancel them from the UI or POST /api/runs/<id>/cancel)`);
  }

  if (options.junit) {
    await deps.writeFile(options.junit, renderJUnit(runs, api.base));
    io.err(`wrote JUnit report to ${options.junit}`);
  }
  const code = exitCodeForRuns(runs, options.failOn, timedOut);
  if (options.json) {
    io.out(JSON.stringify({ batchId, timedOut, exitCode: code, runs: runs.map((r) => summarizeRun(r, api.base)) }, null, 2));
  } else {
    io.out(runs.map((r) => formatRun(r, api.base)).join("\n\n"));
  }
  return code;
}

/** `tapocalypse status <id>`: batches have ids starting with `b-`. */
export async function executeStatus(id: string, json: boolean, deps: Pick<RunDeps, "api" | "io">): Promise<number> {
  const { api, io } = deps;
  if (id.startsWith("b-")) {
    const batch = await api.request<BatchLite & { status?: string; verdict?: Verdict | null }>("GET", `/api/batches/${id}`);
    if (json) io.out(JSON.stringify(batch, null, 2));
    else {
      io.out(`batch ${batch.id}  ${oneLine(batch.title)}  ${batch.status ?? ""}${batch.verdict ? `  ${batch.verdict}` : ""}`.trimEnd());
      for (const r of batch.runs) io.out(`\n${formatRun(r, api.base)}`);
    }
    return EXIT.OK;
  }
  const run = await api.request<RunLite>("GET", `/api/runs/${id}`);
  io.out(json ? JSON.stringify(run, null, 2) : formatRun(run, api.base));
  return EXIT.OK;
}

/** `tapocalypse report <runId>`: markdown to stdout, or (with --export) copy the artefacts into a directory. */
export async function executeReport(
  options: { id: string; exportDir: string | null; json: boolean },
  deps: Pick<RunDeps, "api" | "io">,
): Promise<number> {
  const { api, io } = deps;
  const id = encodeURIComponent(options.id);
  if (options.exportDir !== null) {
    const result = await api.request<{ report: string | null; screenshots: string[] }>("POST", `/api/runs/${id}/export`, { dir: options.exportDir });
    if (options.json) io.out(JSON.stringify(result, null, 2));
    else {
      io.out(result.report ? `report: ${result.report}` : "report: none (the run wrote no report)");
      io.out(`${result.screenshots.length} screenshots in ${path.join(options.exportDir, "screenshots")}`);
    }
    return EXIT.OK;
  }
  const { markdown } = await api.request<{ markdown: string }>("GET", `/api/runs/${id}/report`);
  if (options.json) {
    const run = await api.request<RunLite>("GET", `/api/runs/${id}`);
    io.out(JSON.stringify({ runId: options.id, reportPath: run.reportFile ?? null, markdown }, null, 2));
  } else {
    io.out(markdown);
  }
  return EXIT.OK;
}

/** `tapocalypse service <action>`: prints the service's lines; exits 2 when the action did not succeed. */
export async function executeService(
  action: ServiceAction,
  serviceCommand: (action: ServiceAction) => Promise<{ ok: boolean; lines: string[] }>,
  io: Io,
): Promise<number> {
  const { ok, lines } = await serviceCommand(action);
  for (const line of lines) (ok ? io.out : io.err)(line);
  return ok ? EXIT.OK : EXIT.ERROR;
}

async function packageVersion(): Promise<string> {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
  return pkg.version;
}

/** Runs the CLI; resolves to an exit code, or `null` when the server was started and the process must stay alive. */
export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number | null> {
  let command: Command;
  try {
    command = parseCli(argv, env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}\nRun \`tapocalypse --help\` for usage.`);
    return EXIT.USAGE;
  }

  switch (command.name) {
    case "help":
      console.log(USAGE);
      return EXIT.OK;
    case "version":
      console.log(await packageVersion());
      return EXIT.OK;
    case "serve":
      // Config reads the port when first imported, so the override must be in place before the server module loads.
      if (command.port !== null) process.env.TAPOCALYPSE_PORT = String(command.port);
      // server.ts runs Bun's development server (HMR, browser console forwarding) unless NODE_ENV is "production".
      process.env.NODE_ENV = command.dev ? "development" : "production";
      await import("./server");
      return null;
    case "doctor":
      // scripts/doctor.ts runs its checks as a top-level side effect, so it can only be loaded on demand.
      await import("../scripts/doctor");
      return EXIT.OK;
    case "service": {
      // The service module reads config and probes devices at import time; keep it out of the other commands.
      const service = await import("./service");
      const serviceDeps = service.defaultServiceDeps();
      try {
        return await executeService(command.action, (action) => service.serviceCommand(action, serviceDeps), consoleIo);
      } catch (e) {
        console.error(`error: ${oneLine(e instanceof Error ? e.message : String(e))}`);
        return EXIT.ERROR;
      }
    }
    case "run":
    case "status":
    case "report": {
      const base = command.name === "run" ? command.options.url : command.url;
      const deps = defaultRunDeps(base, env);
      try {
        if (command.name === "run") return await executeRun(command.options, deps);
        if (command.name === "status") return await executeStatus(command.id, command.json, deps);
        return await executeReport(command, deps);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`error: ${oneLine(message)}`);
        return exitCodeForError(e);
      }
    }
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
