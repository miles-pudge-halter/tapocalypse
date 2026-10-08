import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects } from "./registry";
import type { Framework } from "./detect";

export interface FolderSuggestion {
  path: string;
  name: string;
  framework: Framework;
  alreadyAdded: boolean;
}

export interface SuggestOptions {
  /** Folders to scan (default: the usual project parents under the home directory). */
  roots?: string[];
  /** Repo paths that are already registered (default: the project registry). */
  added?: string[];
  limit?: number;
  deadlineMs?: number;
}

const DEFAULT_ROOT_NAMES = ["Projects", "projects", "code", "src", "dev", "Developer", "AndroidStudioProjects", "StudioProjects", "workspace"];
const MAX_DEPTH = 2;
const SKIP_DIRS: Record<string, true> = { node_modules: true, build: true, Pods: true, vendor: true, DerivedData: true };
const XCODE_PARENTS = ["", "ios"];
const GRADLE_APP_DIRS = ["app", "android/app"];
const MAX_MARKER_BYTES = 1024 * 1024;

const readSmall = (file: string): string | null => {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_MARKER_BYTES ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
};

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const entriesOf = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** "shop_app" → "Shop App"; npm scope dropped. */
function humanise(raw: string): string {
  const words = raw.replace(/^@[^/]+\//, "").split(/[_\-\s.]+/).filter(Boolean);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/** Cheap app-marker probe of one folder: a handful of stat calls plus two small reads. Null when it is not a mobile app. */
export function probeAppFolder(dir: string): { framework: Framework; name: string } | null {
  const fallbackName = humanise(path.basename(dir)) || path.basename(dir);

  const pubspec = readSmall(path.join(dir, "pubspec.yaml"));
  if (pubspec !== null && /^\s*flutter:|sdk:\s*flutter/m.test(pubspec)) {
    const pkgName = /^name:\s*["']?([^\s"'#]+)/m.exec(pubspec)?.[1];
    return { framework: "flutter", name: pkgName ? humanise(pkgName) : fallbackName };
  }

  const pkgText = readSmall(path.join(dir, "package.json"));
  if (pkgText !== null) {
    try {
      const pkg = JSON.parse(pkgText) as { name?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const framework: Framework | null = "expo" in deps ? "expo" : "react-native" in deps ? "react-native" : null;
      if (framework) return { framework, name: typeof pkg.name === "string" && pkg.name ? humanise(pkg.name) : fallbackName };
    } catch {
      // not valid JSON: not a marker
    }
  }

  const hasAndroid = GRADLE_APP_DIRS.some((d) => isFile(path.join(dir, d, "build.gradle")) || isFile(path.join(dir, d, "build.gradle.kts")));
  const hasIos = XCODE_PARENTS.some((parent) =>
    entriesOf(path.join(dir, parent)).some((e) => e.endsWith(".xcodeproj") && e !== "Pods.xcodeproj"),
  );
  if (hasAndroid && hasIos) return { framework: ["shared", "composeApp"].some((m) => fs.existsSync(path.join(dir, m))) ? "kmp" : "unknown", name: fallbackName };
  if (hasAndroid) return { framework: "android", name: fallbackName };
  if (hasIos) return { framework: "ios", name: fallbackName };
  return null;
}

const realOrSelf = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Mobile app folders under the usual project parents (depth ≤ 2, ≤ 40 results, ≤ 3 s), newest first, already-added ones last.
 * A folder that is itself an app is not searched further, so `ios/` and `android/` subfolders never appear on their own.
 */
export async function suggestProjectFolders(opts: SuggestOptions = {}): Promise<FolderSuggestion[]> {
  const limit = opts.limit ?? 40;
  const deadline = Date.now() + (opts.deadlineMs ?? 3_000);
  const roots = opts.roots ?? DEFAULT_ROOT_NAMES.map((n) => path.join(os.homedir(), n));
  const added = new Set((opts.added ?? listProjects().map((p) => p.repoPath)).map(realOrSelf));
  const seen = new Set<string>();
  const found: (FolderSuggestion & { mtime: number })[] = [];

  async function scan(dir: string, depth: number): Promise<void> {
    if (Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (Date.now() > deadline) return;
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS[e.name]) continue;
      const child = path.join(dir, e.name);
      const real = realOrSelf(child);
      if (seen.has(real)) continue;
      seen.add(real);
      const app = probeAppFolder(child);
      if (app) {
        let mtime = 0;
        try {
          mtime = fs.statSync(child).mtimeMs;
        } catch {
          // vanished mid-scan; keep with the oldest rank
        }
        found.push({ path: real, name: app.name, framework: app.framework, alreadyAdded: added.has(real), mtime });
      } else if (depth < MAX_DEPTH) {
        await scan(child, depth + 1);
      }
    }
  }

  for (const root of roots) await scan(root, 1);
  found.sort((a, b) => Number(a.alreadyAdded) - Number(b.alreadyAdded) || b.mtime - a.mtime);
  return found.slice(0, limit).map(({ mtime: _mtime, ...s }) => s);
}
