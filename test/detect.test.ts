import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProject } from "../src/projects/detect";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-detect-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** Creates a fixture repo from a { relativePath: contents } map; `/` suffix = empty dir. */
function fixture(name: string, files: Record<string, string>): string {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (rel.endsWith("/")) {
      fs.mkdirSync(abs, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const FLUTTER_GRADLE = `
android {
    namespace "com.example.shop"
    defaultConfig {
        // applicationId "commented.out"
        applicationId "com.example.shop"
    }
    flavorDimensions "default"
    productFlavors {
        production {
            dimension "default"
            applicationIdSuffix ""
            manifestPlaceholders = [appName: "Shop"]
        }
        development {
            dimension "default"
            applicationIdSuffix ".dev"
        }
    }
}
`;

const PBXPROJ = `
  PRODUCT_BUNDLE_IDENTIFIER = com.example.shop;
  PRODUCT_BUNDLE_IDENTIFIER = com.example.shop.dev;
  PRODUCT_BUNDLE_IDENTIFIER = "$(APP_BUNDLE_ID)";
  PRODUCT_BUNDLE_IDENTIFIER = com.example.shop.RunnerTests;
`;

describe("detectProject", () => {
  test("Flutter: pubspec, flavor variants, literal bundle ids only", async () => {
    const root = fixture("flutter", {
      "pubspec.yaml": "name: shop_app_flutter\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "android/app/build.gradle": FLUTTER_GRADLE,
      "ios/Runner.xcodeproj/project.pbxproj": PBXPROJ,
    });
    const d = await detectProject(root);
    expect(d.exists).toBe(true);
    expect(d.framework).toBe("flutter");
    expect(d.platforms).toEqual(["android", "ios"]);
    expect(d.name).toBe("Shop App Flutter");
    expect(d.androidPackages).toEqual(["com.example.shop", "com.example.shop.dev"]);
    expect(d.iosBundleIds).toEqual(["com.example.shop", "com.example.shop.dev", "com.example.shop.RunnerTests"]);
    expect(d.suggestion).toEqual({
      id: "shop-app-flutter",
      name: "Shop App Flutter",
      defaultPlatform: "android",
      defaultPackage: "com.example.shop.dev",
      personaFile: null,
      reportsDir: "qa",
    });
  });

  test("Expo: package.json dependency plus app.json ids", async () => {
    const root = fixture("expo", {
      "package.json": JSON.stringify({ name: "@acme/trail-app", dependencies: { expo: "~52.0.0", "react-native": "0.76.0" } }),
      "app.json": JSON.stringify({ expo: { name: "Trail", android: { package: "com.acme.trail" }, ios: { bundleIdentifier: "com.acme.trail.ios" } } }),
    });
    const d = await detectProject(root);
    expect(d.framework).toBe("expo");
    expect(d.platforms).toEqual(["android", "ios"]);
    expect(d.name).toBe("Trail App");
    expect(d.androidPackages).toEqual(["com.acme.trail"]);
    expect(d.iosBundleIds).toEqual(["com.acme.trail.ios"]);
    expect(d.suggestion.defaultPackage).toBe("com.acme.trail");
  });

  test("native Android (Kotlin DSL): root app module and rootProject.name", async () => {
    const root = fixture("native-android", {
      "settings.gradle.kts": 'rootProject.name = "my-cool-app"\ninclude(":app")\n',
      "app/build.gradle.kts": `android {
  defaultConfig { applicationId = "com.example.app" }
  productFlavors {
    create("staging") { applicationIdSuffix = ".staging" }
    create("dev") { applicationIdSuffix = ".debug" }
  }
}`,
    });
    const d = await detectProject(root);
    expect(d.framework).toBe("android");
    expect(d.platforms).toEqual(["android"]);
    expect(d.name).toBe("My Cool App");
    expect(d.androidPackages).toEqual(["com.example.app", "com.example.app.staging", "com.example.app.debug"]);
    expect(d.suggestion.defaultPackage).toBe("com.example.app.debug");
    expect(d.suggestion.defaultPlatform).toBe("android");
  });

  test("native Android without flavors suggests the base id", async () => {
    const root = fixture("native-android-plain", {
      "app/build.gradle": 'android { defaultConfig { applicationId "org.plain.app" } }',
    });
    const d = await detectProject(root);
    expect(d.androidPackages).toEqual(["org.plain.app"]);
    expect(d.suggestion.defaultPackage).toBe("org.plain.app");
  });

  test("native iOS: xcodeproj at the root defaults to the ios platform", async () => {
    const root = fixture("native-ios", {
      "Foo.xcodeproj/project.pbxproj": "PRODUCT_BUNDLE_IDENTIFIER = com.foo.app;\n",
    });
    const d = await detectProject(root);
    expect(d.framework).toBe("ios");
    expect(d.platforms).toEqual(["ios"]);
    expect(d.iosBundleIds).toEqual(["com.foo.app"]);
    expect(d.suggestion.defaultPlatform).toBe("ios");
    expect(d.suggestion.defaultPackage).toBe("com.foo.app");
  });

  test("a missing path reports exists:false and does not throw", async () => {
    const d = await detectProject(path.join(tmpRoot, "does-not-exist"));
    expect(d.exists).toBe(false);
    expect(d.isGitRepo).toBe(false);
    expect(d.framework).toBe("unknown");
    expect(d.androidPackages).toEqual([]);
    expect(d.suggestion.reportsDir).toBe("qa");
    expect(d.suggestion.defaultPackage).toBeNull();
  });

  test("a regular file is not a repository", async () => {
    const root = fixture("a-file-parent", { "file.txt": "x" });
    expect((await detectProject(path.join(root, "file.txt"))).exists).toBe(false);
  });

  test("isGitRepo follows git init", async () => {
    const root = fixture("git-repo", { "README.md": "x" });
    expect((await detectProject(root)).isGitRepo).toBe(false);
    Bun.spawnSync(["git", "init", "-q", root]);
    expect((await detectProject(root)).isGitRepo).toBe(true);
  });

  test("persona candidates need qa/test in the name; reports dirs must exist", async () => {
    const root = fixture("personas", {
      ".omp/agents/mobile-qa.md": "---\nmodel: a/b\n---\nbody",
      ".omp/agents/reviewer.md": "body",
      ".omp/agents/smoke-test.md": "body",
      ".claude/agents/qa-bot.md": "body",
      "docs/qa/": "",
      "qa/": "",
    });
    const d = await detectProject(root);
    expect(d.personaCandidates).toContain(".omp/agents/mobile-qa.md");
    expect(d.personaCandidates).toContain(".claude/agents/qa-bot.md");
    expect(d.personaCandidates).toContain(".omp/agents/smoke-test.md");
    expect(d.personaCandidates).not.toContain(".omp/agents/reviewer.md");
    expect(d.personaCandidates.indexOf(".omp/agents/smoke-test.md")).toBeGreaterThan(
      d.personaCandidates.indexOf(".claude/agents/qa-bot.md"),
    );
    expect(d.reportsDirCandidates).toEqual(["qa", "docs/qa"]);
    expect(d.suggestion.personaFile).toBe(".omp/agents/mobile-qa.md");
    expect(d.suggestion.reportsDir).toBe("qa");
  });

  test("a repo with nothing recognisable falls back to the directory name", async () => {
    const root = fixture("my_empty-repo", { "README.md": "x" });
    const d = await detectProject(root);
    expect(d.framework).toBe("unknown");
    expect(d.platforms).toEqual([]);
    expect(d.name).toBe("My Empty Repo");
    expect(d.suggestion.id).toBe("my-empty-repo");
    expect(d.suggestion.personaFile).toBeNull();
  });
});
