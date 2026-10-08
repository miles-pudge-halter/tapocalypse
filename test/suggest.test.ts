import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeAppFolder, suggestProjectFolders } from "../src/projects/suggest";

let tmp: string;

const write = (rel: string, content = "") => {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-suggest-")));
  write("Projects/shop_app/pubspec.yaml", "name: shop_app\nflutter:\n  uses-material-design: true\n");
  write("Projects/shop_app/android/app/build.gradle", "");
  write("Projects/rn/package.json", JSON.stringify({ name: "rn-thing", dependencies: { "react-native": "0.76" } }));
  write("Projects/web/package.json", JSON.stringify({ name: "web", dependencies: { react: "19" } }));
  write("Projects/group/native/app/build.gradle.kts", "");
  write("Projects/group/ios-app/Foo.xcodeproj/project.pbxproj", "");
  write("Projects/node_modules/pkg/pubspec.yaml", "flutter:\n");
  write("Projects/.hidden/pubspec.yaml", "flutter:\n");
  write("Projects/deep/a/b/pubspec.yaml", "flutter:\n");
  write("Projects/plain/readme.md", "");
  fs.utimesSync(path.join(tmp, "Projects/rn"), new Date(2020, 0, 1), new Date(2020, 0, 1));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("probeAppFolder", () => {
  test("recognises flutter, react-native, expo, native android and ios markers", () => {
    expect(probeAppFolder(path.join(tmp, "Projects/shop_app"))).toEqual({ framework: "flutter", name: "Shop App" });
    expect(probeAppFolder(path.join(tmp, "Projects/rn"))).toEqual({ framework: "react-native", name: "Rn Thing" });
    expect(probeAppFolder(path.join(tmp, "Projects/group/native"))).toEqual({ framework: "android", name: "Native" });
    expect(probeAppFolder(path.join(tmp, "Projects/group/ios-app"))).toEqual({ framework: "ios", name: "Ios App" });
  });

  test("ordinary folders and plain web packages are not apps", () => {
    expect(probeAppFolder(path.join(tmp, "Projects/web"))).toBeNull();
    expect(probeAppFolder(path.join(tmp, "Projects/plain"))).toBeNull();
  });
});

describe("suggestProjectFolders", () => {
  const roots = () => [path.join(tmp, "Projects"), path.join(tmp, "missing-root")];

  test("finds apps up to two levels deep, skipping hidden, node_modules, deeper folders and an app's own subfolders", async () => {
    const found = await suggestProjectFolders({ roots: roots(), added: [] });
    expect(found.map((f) => path.relative(tmp, f.path)).sort()).toEqual([
      "Projects/group/ios-app",
      "Projects/group/native",
      "Projects/rn",
      "Projects/shop_app",
    ]);
  });

  test("already-added folders are flagged and sorted last; the rest are newest first", async () => {
    const found = await suggestProjectFolders({ roots: roots(), added: [path.join(tmp, "Projects/shop_app")] });
    expect(found.at(-1)).toMatchObject({ path: path.join(tmp, "Projects/shop_app"), alreadyAdded: true, framework: "flutter" });
    expect(found.slice(0, -1).every((f) => !f.alreadyAdded)).toBe(true);
    expect(found.at(-2)?.path).toBe(path.join(tmp, "Projects/rn"));
  });

  test("honours the result limit", async () => {
    expect(await suggestProjectFolders({ roots: roots(), added: [], limit: 2 })).toHaveLength(2);
  });

  test("a spent deadline returns what it has instead of hanging", async () => {
    expect(await suggestProjectFolders({ roots: roots(), added: [], deadlineMs: -1 })).toEqual([]);
  });
});
