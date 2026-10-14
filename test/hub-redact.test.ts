import { describe, expect, test } from "bun:test";
import { createRedactor } from "../src/hub/redact";

const ctx = {
  home: "/Users/you",
  repos: ["/Users/you/Projects/acme-shop", "/Users/you/Projects/acme-shop-wt/feature", "/Users/you/Projects/acme-shop/.worktrees/hotfix"],
  dataDir: "/Users/you/.local/share/tapocalypse",
  tmpDirs: ["/tmp"],
};

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const fakeJwt = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"acme-test-user"}')}.${b64url("not-a-real-signature")}`;

describe("path redaction", () => {
  test("the most specific prefix wins and the rest of the path is kept", () => {
    const r = createRedactor(ctx);
    expect(r.text("read /Users/you/Projects/acme-shop/lib/main.dart")).toBe("read <repo>/lib/main.dart");
    expect(r.text("cd /Users/you/Projects/acme-shop-wt/feature && ls")).toBe("cd <repo> && ls");
    expect(r.text("cd /Users/you/Projects/acme-shop/.worktrees/hotfix/lib")).toBe("cd <repo>/lib"); // a worktree nested in the repo
    expect(r.text("open /Users/you/Documents/notes.txt")).toBe("open ~/Documents/notes.txt");
    expect(r.text("db at /Users/you/.local/share/tapocalypse/runs/1/run.json")).toBe("db at <data>/runs/1/run.json");
    expect(r.replaced).toEqual({ repo: 3, home: 1, data: 1 });
  });

  test("temp folders collapse to <tmp>, including macOS per-user temp dirs", () => {
    const r = createRedactor(ctx);
    expect(r.text("/tmp/acme-abc123/shot.png")).toBe("<tmp>/acme-abc123/shot.png");
    expect(r.text("/private/var/folders/zz/k3j9x_fake0000gn/T/acme-run/x.png and /var/folders/ab/cd12_efgh/T/y")).toBe(
      "<tmp>/acme-run/x.png and <tmp>/y",
    );
    expect(r.replaced.tmp).toBe(3);
  });

  test("a path that merely starts with the same characters is left alone", () => {
    const r = createRedactor(ctx);
    expect(r.text("/mnt/Users/you/x and /tmpfs/x and /Usersfile/x")).toBe("/mnt/Users/you/x and /tmpfs/x and /Usersfile/x");
    expect(r.replaced).toEqual({});
  });

  test("another user's home directory (macOS and Linux) never reaches the hub, whatever the user's name", () => {
    const r = createRedactor(ctx);
    const out = r.text("cp /Users/bob.smith/Downloads/a.png /home/ann-lee/work and /Users/you/ok");
    expect(out).toBe("cp ~other/Downloads/a.png ~other/work and ~/ok");
    expect(r.replaced).toEqual({ "home-other": 2, home: 1 });
  });

  test("percent-encoded paths are redacted like plain ones", () => {
    const r = createRedactor(ctx);
    const out = r.text("open https://x.example/view?file=%2FUsers%2Fbob%2Fsecret.png&cwd=%2fUsers%2fyou%2fProjects%2Facme-shop%2Flib&t=%2Fvar%2Ffolders%2Fab%2Fcd12_efgh%2FT%2Fx");
    expect(out).not.toMatch(/bob|folders|Projects/i);
    expect(out).toContain("<repo>");
    expect(out).toContain("<tmp>");
  });

  test("a temp path cut short by truncation is still redacted", () => {
    const r = createRedactor(ctx);
    expect(r.text('{"paths":["/var/folders/ab/cd12_efgh/T/work/a.dart","/var/folders/ab/cd12')).toBe('{"paths":["<tmp>/work/a.dart","<tmp>');
    expect(r.text("/var/folders/ab/cd12_efgh/")).toBe("<tmp>/");
  });
});

describe("account name", () => {
  test("the local account name in command output becomes <user>, as a whole word only", () => {
    const r = createRedactor({ ...ctx, user: "jdoe42" });
    const ls = "drwxr-xr-x@   3 jdoe42  wheel     96 Oct 14 15:57 .";
    const lsof = "devicekit 47687 jdoe42    5u  IPv4 0x7d19      0t0  TCP *:8100 (LISTEN)";
    expect(r.text(ls)).toBe("drwxr-xr-x@   3 <user>  wheel     96 Oct 14 15:57 .");
    expect(r.text(lsof)).toBe("devicekit 47687 <user>    5u  IPv4 0x7d19      0t0  TCP *:8100 (LISTEN)");
    expect(r.text("jdoe42x and xjdoe42 and jdoe42_build stay")).toBe("jdoe42x and xjdoe42 and jdoe42_build stay");
    expect(r.replaced.user).toBe(2);
  });

  test("an email address keeps its local part, and the home path still becomes ~", () => {
    const r = createRedactor({ ...ctx, home: "/Users/jdoe42", user: "jdoe42" });
    expect(r.text("mail jdoe42@example.com about /Users/jdoe42/notes.md")).toBe("mail jdoe42@example.com about ~/notes.md");
  });

  test("generic system accounts and very short names are not treated as personal", () => {
    expect(createRedactor({ ...ctx, user: "root" }).text("the root cause, owned by root")).toBe("the root cause, owned by root");
    expect(createRedactor({ ...ctx, user: "runner" }).text("test runner")).toBe("test runner");
    expect(createRedactor({ ...ctx, user: "jo" }).text("jo said hi")).toBe("jo said hi");
  });
});

describe("secret patterns", () => {
  test("each kind is replaced and counted, tokens vanish from the output", () => {
    const input = [
      `curl -H "Authorization: Bearer ${fakeJwt}" https://api.example.com`,
      `bare ${fakeJwt}`,
      "key sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234 and sk-FAKEFAKEFAKEFAKEFAKE1234",
      "gh ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234 pat github_pat_FAKEFAKEFAKEFAKEFAKE_1234",
      "aws AKIAFAKEFAKEFAKE1234 google AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1 slack xoxb-1234567890-fakefake",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKE\n-----END RSA PRIVATE KEY-----",
      '{"password":"hunter2","api_key":"abc123","note":"ok","tokensIn":12}',
    ].join("\n");
    const r = createRedactor({});
    const out = r.text(input);
    for (const leaked of [fakeJwt, "sk-ant-api03", "sk-FAKE", "ghp_FAKE", "github_pat_", "AKIAFAKE", "AIzaFAKE", "xoxb-", "MIIFAKE", "hunter2", "abc123"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("«redacted:bearer»");
    expect(out).toContain('"note":"ok"');
    expect(out).toContain('"tokensIn":12');
    expect(r.replaced).toEqual({
      bearer: 1,
      jwt: 1,
      "sk-ant": 1,
      sk: 1,
      github: 2,
      aws: 1,
      google: 1,
      slack: 1,
      "private-key": 1,
      "secret-field": 2,
    });
  });

  test("the hub's own upload token, vendor keys and URL credentials are replaced", () => {
    const r = createRedactor({});
    const tpu = `tpu_${"Ab0_-".repeat(9)}xyz`;
    const input = [
      `token ${tpu} end`,
      "clone https://deploy:hunter2@git.example.com/acme/shop.git and https://ghx0123456789abcdefghijkl@host.example/x",
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      `stripe sk_${"live"}_FAKEFAKEFAKEFAKEFAKE1234 npm npm_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234 oauth ya29.FAKEFAKEFAKEFAKEFAKE1234 gl glpat-FAKEFAKEFAKEFAKE1234 sendgrid SG.FAKEFAKEFAKEFAKEFA.FAKEFAKEFAKEFAKEFAKE`,
      "temp ASIAFAKEFAKEFAKE1234",
    ].join("\n");
    const out = r.text(input);
    for (const leaked of [tpu, "hunter2", "ghx0123456789", "dXNlcjpw", "sk_live_", "npm_FAKE", "ya29.", "glpat-", "SG.FAKE", "ASIAFAKE"]) expect(out).not.toContain(leaked);
    expect(out).toContain("https://«redacted:url-credentials»@git.example.com/acme/shop.git");
    expect(out).toContain("Authorization: «redacted:basic»");
  });

  test("a secret-named variable or header loses its value, with the name and the separator kept", () => {
    const r = createRedactor({});
    const out = r.text(
      [
        "export API_TOKEN=abc123def",
        "password: hunter2",
        "client_secret='two words'",
        "x-api-key: k-12345",
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "DB_PASSWORD=\"p@ss word\" ok",
      ].join("\n"),
    );
    for (const leaked of ["abc123def", "hunter2", "two words", "k-12345", "wJalrXUtn", "p@ss word"]) expect(out).not.toContain(leaked);
    expect(out).toContain("export API_TOKEN=«redacted:secret-assignment»");
    expect(out).toContain("x-api-key: «redacted:secret-assignment»");
    expect(out.endsWith("ok")).toBe(true);
    // Counters, token counts and prose that merely contain the word are left alone.
    expect(r.text("tokensIn: 12, max_tokens=50, the passwordless flow, tokenizer=bpe")).toBe("tokensIn: 12, max_tokens=50, the passwordless flow, tokenizer=bpe");
  });

  test("emails, ticket keys and ordinary prose are not touched", () => {
    const r = createRedactor({});
    const text = "Log in as tester@acme.example, see ACME-12: the skeleton screen shows a task-list.";
    expect(r.text(text)).toBe(text);
    expect(r.replaced).toEqual({});
  });
});

describe("value", () => {
  test("redacts every string in nested data without touching the input, and by key name for secrets", () => {
    const r = createRedactor(ctx);
    const input = {
      title: "Open /Users/you/Projects/acme-shop/README.md",
      args: { path: "/tmp/x.png", token: "plain-looking-secret", count: 3, nested: [{ headers: { authorization: "Basic abc" } }, "ok", null] },
    };
    const snapshot = structuredClone(input);
    const out = r.value(input);
    expect(input).toEqual(snapshot);
    expect(out).toEqual({
      title: "Open <repo>/README.md",
      args: { path: "<tmp>/x.png", token: "«redacted:secret-field»", count: 3, nested: [{ headers: { authorization: "«redacted:secret-field»" } }, "ok", null] },
    });
    expect(r.replaced).toEqual({ repo: 1, tmp: 1, "secret-field": 2 });
  });

  test("strings nested in arrays under tool arguments are redacted too (codex file_change paths)", () => {
    const r = createRedactor(ctx);
    const item = { kind: "tool", tool: "edit", args: { path: "/var/folders/ab/cd12_efgh/T/w/a.dart", paths: ["/var/folders/ab/cd12_efgh/T/w/a.dart", "/private/var/folders/ab/cd12_efgh/T/w/b.dart", { from: "/Users/bob/c.dart", env: ["API_TOKEN=abc123def"] }] } };
    expect(JSON.stringify(r.value(item))).toBe(
      JSON.stringify({ kind: "tool", tool: "edit", args: { path: "<tmp>/w/a.dart", paths: ["<tmp>/w/a.dart", "<tmp>/w/b.dart", { from: "~other/c.dart", env: ["API_TOKEN=«redacted:secret-assignment»"] }] } }),
    );
  });

  test("running the redactor over its own output changes nothing", () => {
    const first = createRedactor(ctx);
    const once = first.text(`Bearer ${fakeJwt} in /Users/you/Projects/acme-shop`);
    const second = createRedactor(ctx);
    expect(second.text(once)).toBe(once);
    expect(second.replaced).toEqual({});
  });
});
