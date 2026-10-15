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

/** Values are plain words on purpose: only the NAME around them may be what gets them redacted. */
const SECRET = "zq7Kd2LmPw9x";
const hasNone = (out: string) => expect(out).not.toContain(SECRET);

describe("secret names in every spelling", () => {
  const camel = ["accessToken", "refreshToken", "idToken", "authToken", "clientSecret", "secretAccessKey", "apiKey", "APIKey", "AccountKey", "SharedAccessKey", "password", "Password", "passwd", "sessionId", "ACCESSTOKEN"];

  test("camelCase and PascalCase names lose their value as `name=value`, `name: value` and JSON fields", () => {
    for (const name of camel) {
      const r = createRedactor({});
      const out = [r.text(`${name}=${SECRET} and more`), r.text(`${name}: ${SECRET}`), r.text(`{"${name}":"${SECRET}","ok":1}`), r.text(`{ "${name}" : "${SECRET}" }`)];
      for (const o of out) hasNone(o);
      expect(out[0]).toBe(`${name}=«redacted:secret-assignment» and more`);
      expect(out[2]).toBe(`{"${name}":"«redacted:secret-field»","ok":1}`);
    }
  });

  test("object keys are redacted by the same rule", () => {
    const input = Object.fromEntries(camel.map((name) => [name, SECRET]));
    const out = createRedactor({}).value({ ...input, nested: [{ ...input }] });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).toMatchObject({ accessToken: "«redacted:secret-field»" });
  });

  test("counters and names that merely contain the word stay", () => {
    const r = createRedactor({});
    const keep = ["maxTokens", "inputTokens", "outputTokens", "tokenCount", "max_tokens", "tokensIn", "tokensOut", "tokenizer", "sessionCount", "passwordless", "secretary", "sidebar"];
    const input = Object.fromEntries(keep.map((name) => [name, "12"]));
    expect(r.value(input)).toEqual(input);
    const line = keep.map((name) => `${name}=12`).join(" ") + ' {"maxTokens":"4096","tokenCount":"7"}';
    expect(r.text(line)).toBe(line);
    expect(r.replaced).toEqual({});
  });

  test("cookie, session and sid are secret names; the Cookie header loses its whole value", () => {
    const r = createRedactor({});
    const out = r.text(
      [`Cookie: sid=${SECRET}; theme=dark; other=${SECRET}x`, `Set-Cookie: session=${SECRET}; Path=/; HttpOnly`, `session=${SECRET}`, `session_id: ${SECRET}`, `sessionid=${SECRET}`, `sid=${SECRET}`, `{"cookie":"a=${SECRET}","Set-Cookie":"b=${SECRET}"}`].join("\n"),
    );
    hasNone(out);
    expect(out).not.toContain("theme=dark");
    expect(out).not.toContain("HttpOnly");
    expect(out).toContain("Cookie: «redacted:cookie»");
    expect(out).toContain("Set-Cookie: «redacted:cookie»");
    expect(createRedactor({}).value({ cookie: SECRET, "set-cookie": SECRET, session: SECRET, sid: SECRET, sessionid: SECRET, session_id: SECRET })).toEqual({
      cookie: "«redacted:secret-field»",
      "set-cookie": "«redacted:secret-field»",
      session: "«redacted:secret-field»",
      sid: "«redacted:secret-field»",
      sessionid: "«redacted:secret-field»",
      session_id: "«redacted:secret-field»",
    });
  });

  test("Authorization with any scheme loses the whole value and keeps its name", () => {
    const r = createRedactor({});
    for (const value of [`Token ${SECRET}`, `ApiKey ${SECRET}`, `Digest ${SECRET}`, `Negotiate ${SECRET}`, SECRET, `Bearer ${SECRET}`]) {
      const out = r.text(`Authorization: ${value}`);
      hasNone(out);
      expect(out).toMatch(/^Authorization: «redacted:[a-z-]+»$/);
    }
    expect(r.text(`curl -H 'Authorization: Token ${SECRET}' https://api.example.com`)).toBe("curl -H 'Authorization: «redacted:authorization»' https://api.example.com");
    expect(r.text(`{"Authorization":"Token ${SECRET}"}`)).toBe('{"Authorization":"«redacted:secret-field»"}');
  });
});

describe("command lines", () => {
  test("--password/--passwd/--token/--secret/--api-key/--apikey, with = or a space and any quoting", () => {
    for (const flag of ["--password", "--passwd", "--token", "--secret", "--api-key", "--apikey", "--access-token", "--db_password"]) {
      for (const sep of ["=", " "]) {
        for (const value of [SECRET, `"${SECRET} two"`, `'${SECRET} two'`]) {
          const out = createRedactor({}).text(`tool run ${flag}${sep}${value} --verbose`);
          expect(out).toMatch(/^tool run --[a-z_-]+[= ]«redacted:[a-z-]+» --verbose$/);
          hasNone(out);
        }
      }
    }
    expect(createRedactor({}).text("tool --max-tokens 50 --tokens=3 --password-file /x --no-token")).toBe("tool --max-tokens 50 --tokens=3 --password-file /x --no-token");
  });

  test("curl -u user:pass keeps the user and drops the password", () => {
    const r = createRedactor({});
    expect(r.text(`curl -u deploy:${SECRET} https://x.example/api`)).toBe("curl -u deploy:«redacted:curl-user» https://x.example/api");
    expect(r.text(`curl --user=deploy:${SECRET} -s x`)).toBe("curl --user=deploy:«redacted:curl-user» -s x");
    expect(r.text(`curl -u 'deploy:${SECRET}' x`)).toBe("curl -u 'deploy:«redacted:curl-user»' x");
    expect(r.text("curl -u deploy https://x.example")).toBe("curl -u deploy https://x.example");
  });

  test("URL credentials with an empty user", () => {
    const r = createRedactor({});
    const out = r.text(`REDIS=redis://:${SECRET}@cache.example:6379/0 and postgres://app:${SECRET}@db.example/x`);
    hasNone(out);
    expect(out).toContain("redis://«redacted:url-credentials»@cache.example:6379/0");
    expect(r.text("see http://localhost:8080/path and ws://:9000 and a@b.example")).toBe("see http://localhost:8080/path and ws://:9000 and a@b.example");
  });

  test("PGP private key blocks, whole or cut off", () => {
    const begin = ["-----BEGIN", "PGP PRIVATE KEY BLOCK-----"].join(" ");
    const end = ["-----END", "PGP PRIVATE KEY BLOCK-----"].join(" ");
    const out = createRedactor({}).text(`before\n${begin}\n\nlQdGBF${SECRET}\n=abcd\n${end}\nafter`);
    expect(out).toBe("before\n«redacted:private-key»\nafter");
    expect(createRedactor({}).text(`x ${begin}\nlQdGBF${SECRET}`)).toBe("x «redacted:private-key»");
  });
});

describe("escaped quotes", () => {
  test("a JSON-encoded shell command: assignments quoted as \\\"…\\\" are redacted whole", () => {
    const command = `export API_TOKEN="${SECRET} two" && DB_PASSWORD='${SECRET}' ./run --password "${SECRET} x" && curl -H "Authorization: Token ${SECRET}" -H "Cookie: sid=${SECRET}; a=b" https://x.example`;
    const encoded = JSON.stringify({ kind: "tool", tool: "bash", args: { command } });
    expect(encoded).toContain('\\"');
    const r = createRedactor({});
    const out = r.text(encoded);
    hasNone(out);
    expect(out).not.toContain(" two");
    expect(out).toContain("API_TOKEN=«redacted:secret-assignment»");
    // The result is still valid JSON: no quote of the encoding was eaten.
    expect(JSON.parse(out).args.command).toContain("export API_TOKEN=«redacted:secret-assignment» && ");
  });

  test("any number of backslashes: doubly and triply encoded bodies", () => {
    const body = { accessToken: SECRET, refreshToken: `${SECRET}\nline`, clientSecret: `has \"quote\" ${SECRET}`, max_tokens: 5, note: "ok" };
    let encoded = JSON.stringify(body);
    for (let level = 1; level <= 3; level++) {
      encoded = JSON.stringify({ level, body: encoded });
      const out = createRedactor({}).text(encoded);
      hasNone(out);
      expect(out).not.toContain("line");
      expect(out).toContain("max_tokens");
      expect(out).toContain("note");
      // Still decodable all the way down.
      let inner = JSON.parse(out) as { body: string };
      for (let i = level; i > 1; i--) inner = JSON.parse(inner.body) as { body: string };
      expect(JSON.parse(inner.body)).toMatchObject({ max_tokens: 5, note: "ok" });
    }
  });

  test("a non-secret field does not hide the secret fields nested in its string value", () => {
    const out = createRedactor({}).text(JSON.stringify({ body: `token=${SECRET}`, text: `{"password":"${SECRET}"}` }));
    hasNone(out);
  });

  test("a value cut off by truncation is still redacted", () => {
    const r = createRedactor({});
    hasNone(r.text(`{"accessToken":"${SECRET}`));
    hasNone(r.text(`cmd API_TOKEN=\\"${SECRET}`));
    hasNone(r.text(`cmd API_TOKEN="${SECRET}`));
  });

  test("redacting redacted text changes nothing", () => {
    const input = [
      `Cookie: a=${SECRET}`,
      `Authorization: Token ${SECRET}`,
      `tool --password ${SECRET} --token=${SECRET}`,
      `curl -u me:${SECRET}`,
      `redis://:${SECRET}@h`,
      JSON.stringify({ accessToken: SECRET, cmd: `export API_TOKEN="${SECRET}"` }),
    ].join("\n");
    const once = createRedactor({}).text(input);
    const again = createRedactor({});
    expect(again.text(once)).toBe(once);
    expect(again.replaced).toEqual({});
  });
});

describe("device ids", () => {
  const devices = ["emulator-5554", "Pixel_8_API_35", "00008110-001A2B3C4D5E801E"];

  test("serials, AVD names and UDIDs become <device>, as whole words", () => {
    const r = createRedactor({ devices });
    const out = r.text(
      "adb -s emulator-5554 shell; avd Pixel_8_API_35.avd; xcrun simctl boot 00008110-001a2b3c4d5e801e; " + JSON.stringify({ device: "emulator-5554", args: ["-s", "emulator-5554"] }) + "; emulator-55540 and Pixel_8_API_350 stay",
    );
    expect(out).toBe(
      'adb -s <device> shell; avd <device>.avd; xcrun simctl boot <device>; {"device":"<device>","args":["-s","<device>"]}; emulator-55540 and Pixel_8_API_350 stay',
    );
    expect(r.replaced).toEqual({ device: 5 });
  });

  test("object values, ids too short to be meaningful, and no devices at all", () => {
    expect(createRedactor({ devices }).value({ deviceSerial: "emulator-5554", list: ["x emulator-5554 y"] })).toEqual({ deviceSerial: "<device>", list: ["x <device> y"] });
    expect(createRedactor({ devices: ["ab", ""] }).text("ab and cd")).toBe("ab and cd");
    expect(createRedactor({}).text("emulator-5554")).toBe("emulator-5554");
  });
});

describe("performance", () => {
  const time = (r: ReturnType<typeof createRedactor>, input: string): number => {
    const start = performance.now();
    r.text(input);
    return performance.now() - start;
  };
  const ONE_MB = 1024 * 1024;
  const filler = (unit: string) => unit.repeat(Math.ceil(ONE_MB / unit.length)).slice(0, ONE_MB);

  test("1 MB of ordinary and of adversarial text redacts well under a second", () => {
    const r = createRedactor({ ...ctx, user: "jdoe42", devices: ["emulator-5554"] });
    const inputs = [
      filler(`Tapped the checkout button (ACME-12) and /Users/you/Projects/acme-shop/lib/main.dart rendered, token=${SECRET} next\n`),
      filler("ab-ab-"),
      filler("a.b.c."),
      filler("a_b_c_d_"),
      filler("aaaa"),
      filler("a:b:c "),
      filler('"token":"'),
      filler('\\"password\\":\\"'),
      filler("token="),
      filler('password="'),
      filler("--token "),
      filler("-----BEGIN PRIVATE KEY----- "),
      filler("http://a:b"),
      filler("Authorization: "),
      filler("\\\\\\\\\\\\\\\\"),
      filler("x ".padEnd(64, " ")),
    ];
    for (const input of inputs) expect(time(r, input)).toBeLessThan(1000);
  });
});

describe("prose is not over-redacted", () => {
  test("broad names (session, sid, cookie, token) followed by `:` and prose keep the sentence", () => {
    const r = createRedactor({});
    const prose = [
      "Session: logged in",
      "**Session:** restored after relaunch",
      "**Token:** shown on the settings screen",
      "Token: expired, sign in again",
      "Cookie banner: dismissed",
      "sid: unknown",
      "- `Session`: kept alive",
      "__Session:__ ok",
    ].join("\n");
    expect(r.text(prose)).toBe(prose);
    expect(r.replaced).toEqual({});
  });

  test("broad names still lose an `=` value, a quoted value, a JSON value and a token-looking value after `:`", () => {
    for (const input of [`session=${SECRET}`, `sid="${SECRET}"`, `token: '${SECRET}'`, `{"session":"${SECRET}"}`, `token: ${SECRET}`, `sid: ${SECRET}`, `Session=${SECRET}`]) {
      hasNone(createRedactor({}).text(input));
    }
    expect(createRedactor({}).text(`token=logged in`)).toBe("token=«redacted:secret-assignment» in");
  });

  test("a value never swallows markdown markup, and never starts with it", () => {
    const r = createRedactor({});
    expect(r.text(`**token=${SECRET}** and \`API_TOKEN=${SECRET}\` and __sid=${SECRET}__`)).toBe(
      "**token=«redacted:secret-assignment»** and `API_TOKEN=«redacted:secret-assignment»` and __sid=«redacted:secret-assignment»__",
    );
    expect(r.text("token=** and sid=`x`")).toBe("token=** and sid=`x`");
  });

  test("curl -u keeps numeric uid:gid pairs and still drops real passwords", () => {
    const r = createRedactor({});
    expect(r.text("docker run -u 1000:1000 -u 501:20 alpine")).toBe("docker run -u 1000:1000 -u 501:20 alpine");
    expect(r.text(`curl -u deploy:${SECRET} x`)).toBe("curl -u deploy:«redacted:curl-user» x");
    expect(r.text("curl -u deploy:12345a x")).toBe("curl -u deploy:«redacted:curl-user» x");
  });
});
