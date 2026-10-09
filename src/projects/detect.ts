import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Platform } from "../runs/types";

export type Framework = "flutter" | "react-native" | "expo" | "android" | "ios" | "kmp" | "unknown";

export interface Detection {
  repoPath: string;
  exists: boolean;
  isGitRepo: boolean;
  framework: Framework;
  platforms: Platform[];
  name: string | null;
  androidPackages: string[];
  iosBundleIds: string[];
  personaCandidates: string[];
  reportsDirCandidates: string[];
  suggestion: {
    id: string;
    name: string;
    defaultPlatform: Platform;
    defaultPackage: string | null;
    personaFile: string | null;
    reportsDir: string;
  };
}

const MAX_READ_BYTES = 4 * 1024 * 1024;
const REPORTS_DIR_CANDIDATES = ["qa", "docs/qa", "test/qa", "reports/qa"];
const PERSONA_DIRS = [".omp/agents", ".claude/agents", ".codex/agents"];
const ANDROID_APP_DIRS = ["android/app", "app", "androidApp", "composeApp"];
const XCODE_PARENT_DIRS = ["", "ios", "iosApp"];
const DEV_SUFFIX = /\.(dev|debug)$/;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  const text = readText(p);
  if (text === null) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return [];
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/** "shop_app_flutter" → "Shop App Flutter"; npm scope is dropped. */
function humanise(raw: string): string {
  const unscoped = raw.replace(/^@[^/]+\//, "");
  const words = unscoped.split(/[_\-\s.]+/).filter(Boolean);
  if (words.length === 0) return unscoped;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "project";
}

async function detectGit(repoPath: string): Promise<boolean> {
  if (fs.existsSync(path.join(repoPath, ".git"))) return true;
  try {
    const proc = Bun.spawn(["git", "-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 && out.trim() === "true";
  } catch {
    return false;
  }
}

// ---- gradle ----

function stripGradleComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Body of the first `name { ... }` block, with its position, or null. */
function findBlock(text: string, name: string): { start: number; end: number; body: string } | null {
  const re = new RegExp(`(?:^|[^\\w.])${name}\\s*\\{`, "g");
  const m = re.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(text, open);
  if (close < 0) return null;
  return { start: m.index, end: close + 1, body: text.slice(open + 1, close) };
}

const APPLICATION_ID = /\bapplicationId\s*(?:=\s*)?["']([^"'$]+)["']/;
const APPLICATION_ID_SUFFIX = /\bapplicationIdSuffix\s*(?:=\s*)?["']([^"']*)["']/;
const NAMESPACE = /\bnamespace\s*(?:=\s*)?["']([^"'$]+)["']/;

interface Flavor {
  applicationId: string | null;
  suffix: string;
}

function flavorName(header: string): string | null {
  const line = header.split("\n").pop()?.trim() ?? "";
  const call = /(?:create|register|getByName|maybeCreate)\s*\(\s*["'](\w+)["']\s*\)/.exec(line);
  if (call) return call[1]!;
  const delegated = /(?:val|var)\s+(\w+)\s+by\s+(?:creating|getting)/.exec(line);
  if (delegated) return delegated[1]!;
  const plain = /^(\w+)$/.exec(line);
  return plain ? plain[1]! : null;
}

function parseFlavors(block: string): Flavor[] {
  const flavors: Flavor[] = [];
  let lastEnd = 0;
  for (;;) {
    const open = block.indexOf("{", lastEnd);
    if (open < 0) break;
    const close = matchBrace(block, open);
    if (close < 0) break;
    if (flavorName(block.slice(lastEnd, open)) !== null) {
      const body = block.slice(open + 1, close);
      flavors.push({
        applicationId: APPLICATION_ID.exec(body)?.[1] ?? null,
        suffix: APPLICATION_ID_SUFFIX.exec(body)?.[1] ?? "",
      });
    }
    lastEnd = close + 1;
  }
  return flavors;
}

function manifestPackage(appDir: string): string | null {
  const text = readText(path.join(appDir, "src/main/AndroidManifest.xml"));
  return text ? (/<manifest[^>]*\spackage\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? null) : null;
}

function gradleFile(dir: string): string | null {
  for (const f of ["build.gradle.kts", "build.gradle"]) {
    const p = path.join(dir, f);
    if (isFile(p)) return p;
  }
  return null;
}

/** Base applicationId first, then flavor variants (override ?? base) + suffix. */
function androidPackagesFromGradle(root: string): string[] {
  for (const rel of ANDROID_APP_DIRS) {
    const appDir = path.join(root, rel);
    const file = gradleFile(appDir);
    if (!file) continue;
    const raw = readText(file);
    if (raw === null) continue;
    const text = stripGradleComments(raw);
    const flavorBlock = findBlock(text, "productFlavors");
    const withoutFlavors = flavorBlock ? text.slice(0, flavorBlock.start) + text.slice(flavorBlock.end) : text;
    const base =
      APPLICATION_ID.exec(withoutFlavors)?.[1] ??
      NAMESPACE.exec(withoutFlavors)?.[1] ??
      manifestPackage(appDir) ??
      null;
    const packages: string[] = base ? [base] : [];
    for (const f of flavorBlock ? parseFlavors(flavorBlock.body) : []) {
      const id = f.applicationId ?? base;
      if (id) packages.push(id + f.suffix);
    }
    if (packages.length > 0) return unique(packages);
  }
  return [];
}

// ---- iOS ----

function xcodeprojs(root: string): string[] {
  const found: string[] = [];
  for (const parent of XCODE_PARENT_DIRS) {
    const dir = path.join(root, parent);
    for (const entry of listDir(dir)) {
      if (entry.endsWith(".xcodeproj") && entry !== "Pods.xcodeproj" && isDir(path.join(dir, entry))) {
        found.push(path.join(dir, entry));
      }
    }
  }
  return found;
}

function bundleIdsFromPbxproj(projDir: string): string[] {
  const text = readText(path.join(projDir, "project.pbxproj"));
  if (text === null) return [];
  const ids: string[] = [];
  for (const m of text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\s]+)"?\s*;/g)) {
    const id = m[1]!;
    if (!id.includes("$")) ids.push(id);
  }
  // Test targets are never the app under test: list them last.
  const distinct = unique(ids);
  return [...distinct.filter((i) => !/Tests$/.test(i)), ...distinct.filter((i) => /Tests$/.test(i))];
}

// ---- expo ----

function expoConfig(root: string): { androidPackage: string | null; iosBundleId: string | null; name: string | null } {
  for (const f of ["app.json", "app.config.json"]) {
    const json = readJson(path.join(root, f));
    if (!json) continue;
    const cfg = asRecord(json.expo) ?? json;
    const androidPackage = asString(asRecord(cfg.android)?.package);
    const iosBundleId = asString(asRecord(cfg.ios)?.bundleIdentifier);
    if (androidPackage || iosBundleId) return { androidPackage, iosBundleId, name: asString(cfg.name) };
  }
  return { androidPackage: null, iosBundleId: null, name: null };
}

// ---- candidates ----

function personaCandidates(root: string): string[] {
  const found: string[] = [];
  for (const dir of PERSONA_DIRS) {
    for (const entry of listDir(path.join(root, dir))) {
      if (!entry.endsWith(".md") || !/qa|test/i.test(entry)) continue;
      if (isFile(path.join(root, dir, entry))) found.push(`${dir}/${entry}`);
    }
  }
  return [...found.filter((f) => /qa/i.test(path.basename(f))), ...found.filter((f) => !/qa/i.test(path.basename(f)))];
}

function detectFramework(root: string, hasAndroid: boolean, hasIos: boolean): Framework {
  const pubspec = readText(path.join(root, "pubspec.yaml"));
  if (pubspec !== null && /^\s*flutter:|sdk:\s*flutter/m.test(pubspec)) return "flutter";

  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const deps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
    if ("expo" in deps) return "expo";
    if ("react-native" in deps) return "react-native";
  }

  const hasKmpModule = ["shared", "composeApp"].some((m) => isDir(path.join(root, m)));
  if (hasKmpModule && hasAndroid && hasIos) return "kmp";
  if (hasAndroid && !hasIos) return "android";
  if (hasIos && !hasAndroid) return "ios";
  return "unknown";
}

function detectName(root: string, framework: Framework): string | null {
  if (framework === "flutter") {
    const m = /^name:\s*["']?([^\s"'#]+)/m.exec(readText(path.join(root, "pubspec.yaml")) ?? "");
    if (m) return humanise(m[1]!);
  }
  const pkgName = asString(readJson(path.join(root, "package.json"))?.name);
  if (pkgName) return humanise(pkgName);
  for (const dir of ["", "android"]) {
    for (const f of ["settings.gradle.kts", "settings.gradle"]) {
      const m = /\brootProject\.name\s*=\s*["']([^"']+)["']/.exec(readText(path.join(root, dir, f)) ?? "");
      if (m) return humanise(m[1]!);
    }
  }
  return humanise(path.basename(root)) || null;
}

function emptyDetection(repoPath: string, exists: boolean): Detection {
  const name = humanise(path.basename(repoPath)) || "Project";
  return {
    repoPath,
    exists,
    isGitRepo: false,
    framework: "unknown",
    platforms: [],
    name,
    androidPackages: [],
    iosBundleIds: [],
    personaCandidates: [],
    reportsDirCandidates: [],
    suggestion: {
      id: slugify(name),
      name,
      defaultPlatform: "android",
      defaultPackage: null,
      personaFile: null,
      reportsDir: "qa",
    },
  };
}

function detectSync(repoPath: string): Omit<Detection, "isGitRepo"> {
  const root = repoPath;
  const expo = expoConfig(root);
  const projs = xcodeprojs(root);

  const androidPackages = unique([...androidPackagesFromGradle(root), ...(expo.androidPackage ? [expo.androidPackage] : [])]);
  const iosBundleIds = unique([...projs.flatMap(bundleIdsFromPbxproj), ...(expo.iosBundleId ? [expo.iosBundleId] : [])]);

  const hasAndroid =
    androidPackages.length > 0 || ANDROID_APP_DIRS.some((d) => gradleFile(path.join(root, d)) !== null) ||
    ["android", "androidApp"].some((d) => isDir(path.join(root, d))) ||
    ["shared", "composeApp"].some((m) => isDir(path.join(root, m, "src", "androidMain")));
  const hasIos =
    iosBundleIds.length > 0 || projs.length > 0 ||
    ["ios", "iosApp"].some((d) => isDir(path.join(root, d))) ||
    ["shared", "composeApp"].some((m) => isDir(path.join(root, m, "src", "iosMain")));

  const framework = detectFramework(root, hasAndroid, hasIos);

  const platforms: Platform[] = [];
  if (hasAndroid) platforms.push("android");
  if (hasIos) platforms.push("ios");
  if (platforms.length === 0 && framework !== "unknown" && framework !== "android" && framework !== "ios") {
    platforms.push("android", "ios");
  }

  const name = detectName(root, framework) ?? expo.name;
  const suggestedName = name ?? "Project";
  const personas = personaCandidates(root);
  const reportsDirs = REPORTS_DIR_CANDIDATES.filter((d) => isDir(path.join(root, d)));
  const defaultPlatform: Platform = platforms.includes("android") || !platforms.includes("ios") ? "android" : "ios";
  const suggestedPackages = defaultPlatform === "android" ? androidPackages : iosBundleIds;

  return {
    repoPath: root,
    exists: true,
    framework,
    platforms,
    name,
    androidPackages,
    iosBundleIds,
    personaCandidates: personas,
    reportsDirCandidates: reportsDirs,
    suggestion: {
      id: slugify(suggestedName),
      name: suggestedName,
      defaultPlatform,
      defaultPackage: suggestedPackages.find((id) => DEV_SUFFIX.test(id)) ?? suggestedPackages[0] ?? null,
      personaFile: personas[0] ?? null,
      reportsDir: reportsDirs[0] ?? "qa",
    },
  };
}

export async function detectProject(repoPath: string): Promise<Detection> {
  const resolved = path.resolve(expandHome(typeof repoPath === "string" ? repoPath.trim() : ""));
  try {
    if (!isDir(resolved)) return emptyDetection(resolved, false);
    const sync = detectSync(resolved);
    return { ...sync, isGitRepo: await detectGit(resolved) };
  } catch {
    return emptyDetection(resolved, isDir(resolved));
  }
}
