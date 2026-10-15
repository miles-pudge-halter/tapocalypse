// Pure redaction for everything a laptop uploads to a hub: machine paths (ours, other users' and percent-encoded ones) become
// placeholders, secret-looking strings are replaced as a backstop. Emails, ticket keys and free-form text are deliberately left alone.

export interface RedactContext {
  /** The user's home dir; becomes `~`. */
  home?: string;
  /** The project repo, its worktrees and the git toplevel; become `<repo>`. */
  repos?: string[];
  /** Tapocalypse's data dir; becomes `<data>`. */
  dataDir?: string;
  /** Temp dirs; become `<tmp>` (macOS per-user `/var/folders/…` temp dirs always do). */
  tmpDirs?: string[];
  /** The local account name (`ls -l` and `lsof` print it); becomes `<user>`. Generic accounts and names under 3 chars are kept. */
  user?: string;
  /** Device ids (serial, UDID, AVD name) the run used; each, as a whole word, becomes `<device>`. Ids under 4 characters are ignored: they would mangle prose. */
  devices?: string[];
}

export interface Redactor {
  /** Redacts one string. */
  text(s: string): string;
  /** A redacted deep copy of JSON-like data; the input is never modified. */
  value<T>(v: T): T;
  /** How many replacements each kind made so far (path kinds `home|repo|data|tmp`, then the secret kinds). */
  readonly replaced: Record<string, number>;
}

const marker = (kind: string): string => `«redacted:${kind}»`;

/** A path separator, plain or percent-encoded (`%2F`): URLs carry paths either way. */
const SEP = String.raw`(?:/|%2[Ff])`;
/**
 * Whether a path match may start at `at`: not inside a longer path, name or `~user` (the character before is no path character),
 * or right after an encoded separator. Checked by hand: a lookbehind at the head of a regex defeats the engine's literal scan and
 * makes every pass over a long text several times slower.
 */
function pathStartsAt(s: string, at: number): boolean {
  if (at === 0) return true;
  const c = s.charCodeAt(at - 1);
  const wordish = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 126 || c === 46 || c === 45;
  return !wordish || (at >= 3 && s.charCodeAt(at - 3) === 37 && s.charCodeAt(at - 2) === 50 && (c === 70 || c === 102));
}

/** `s.replace(re, …)` for a regex whose matches must also pass `pathStartsAt`; a rejected match is retried one character later, like a lookbehind would. */
function replacePaths(s: string, re: RegExp, to: (match: string) => string): string {
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!pathStartsAt(s, m.index)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out += s.slice(last, m.index) + to(m[0]);
    last = m.index + m[0].length;
  }
  return last === 0 ? s : out + s.slice(last);
}
const PATH_CHAR_AFTER = String.raw`(?![A-Za-z0-9_~-])`;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The regex source of an absolute path whose `/` also match `%2F`. */
const pathSource = (dir: string): string => dir.split("/").map(escapeRegExp).join(SEP);
// The third segment (`T`, `C`, `0`) and even the second may be missing: activity arguments are truncated mid-path.
const MAC_TEMP = new RegExp(
  `(?:${SEP}private)?${SEP}var${SEP}folders${SEP}[A-Za-z0-9_]+(?:${SEP}[A-Za-z0-9_]+)?(?:${SEP}[A-Za-z0-9]${PATH_CHAR_AFTER})?`,
  "g",
);
/** Somebody else's home directory (`/Users/<name>`, `/home/<name>`): the user is a stranger to the hub's viewers. */
const OTHER_HOME = new RegExp(`${SEP}(?:Users|home)${SEP}[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*`, "g");
/** Shared service accounts: not personal, and replacing them would mangle ordinary words ("root cause", "test runner"). */
const GENERIC_ACCOUNTS: Record<string, true> = Object.fromEntries(
  ["root", "admin", "administrator", "user", "runner", "ubuntu", "debian", "ec2-user", "vagrant", "docker", "bun", "node", "app", "ci", "build", "jenkins", "github", "gitlab-runner"].map((name) => [name, true]),
);

/** The account name as a whole word: not part of a longer name, a path segment, or the local part of an email address. */
function accountName(user: string | undefined): RegExp | null {
  if (!user || user.length < 3 || GENERIC_ACCOUNTS[user.toLowerCase()]) return null;
  return new RegExp(`(?<![A-Za-z0-9_.@/-])${escapeRegExp(user)}(?![A-Za-z0-9_@-])`, "g");
}

/**
 * Words that make a name a secret's name: `token`, `API_TOKEN`, `x-api-key`, `client_secret`, `DB_PASSWORD`, `Authorization`, `Set-Cookie`,
 * `session_id`, `sid`. The name must END in the word (after a separator, or as a camelCase / UPPERCASE suffix), so counters such as
 * `maxTokens`, `inputTokens`, `tokenCount`, `max_tokens` and `tokensIn` stay.
 */
const NAME_WORDS = "token|secret|password|passwd|authorization|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|credentials?|cookie|session[_-]?id|session|sid";
const SEPARATED_NAME = new RegExp(`(?:^|[_-])(?:${NAME_WORDS})$`, "i");
/** `accessToken`, `idToken`, `clientSecret`, `secretAccessKey`, `SharedAccessKey`, `APIKey`, `sessionId`: a capitalised word closing the name. */
const CAMEL_NAME = /[a-z0-9](?:Token|Secret|Password|Passwd|Authorization|ApiKey|APIKey|AccessKey|PrivateKey|AccountKey|Credentials?|Cookie|SessionId|Session|Sid)$/;
const UPPER_NAME = /[A-Z0-9](?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|COOKIE)$/;
const isSecretName = (name: string): boolean => SEPARATED_NAME.test(name) || CAMEL_NAME.test(name) || UPPER_NAME.test(name);
/** Names that are also ordinary words in prose and labels: they need `=` or a quoted value, or a token-looking one after `:`. */
const BROAD_NAME = /(?:^|[_-])(?:token|session|sid|cookie)$/i;
const TOKEN_LOOKING = /^(?=[^\s]*\d)[A-Za-z0-9._~+/=-]{8,}$/;

/** A value after `=`/`:`/a flag: quoted (also `\"…\"` as in JSON-encoded commands, any number of backslashes), cut-off quoted, or bare. */
const VALUE_SOURCE = String.raw`\\+"[^"\n]*?\\+"|\\+"[^"\n]*|"[^"\n]*"|"[^"\n]*|'[^'\n]*'|'[^'\n]*|[^\s"',;&]+`;
const ASSIGNED_VALUE = new RegExp(VALUE_SOURCE, "y");
/** `"name":"` with the quotes escaped k times (`(\\*)`): plain JSON, a JSON-encoded command or a doubly-encoded body. */
const FIELD_OPEN = /(?<!\\)(\\*)"([A-Za-z0-9_-]+)\1"\s*:\s*\1"/g;
const REDACTED_PREFIX = "«redacted:";

/** The separators of assignments: found by character, then the name is read backwards (a regex that opens on every word run costs a pass of its own). */
const SEPARATOR = /[=:]/g;

/**
 * `NAME=value`, `NAME: value`: calls `redact(name, separator, valueStart, s)` for each name directly before a `=` or `:` (whitespace may
 * sit around the separator); a returned span replaces name, separator and value, null leaves it and scanning goes on after the separator.
 */
function assignments(s: string, redact: (name: string, sep: string, from: number, s: string) => { text: string; end: number } | null): string {
  SEPARATOR.lastIndex = 0;
  let out = "";
  let last = 0;
  const isNameChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
  const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xfeff || c === 0x2028 || c === 0x2029;
  for (let m = SEPARATOR.exec(s); m; m = SEPARATOR.exec(s)) {
    let nameEnd = m.index;
    while (nameEnd > last && isSpace(s.charCodeAt(nameEnd - 1))) nameEnd--;
    let nameStart = nameEnd;
    while (nameStart > last && isNameChar(s.charCodeAt(nameStart - 1))) nameStart--;
    if (nameStart === nameEnd) continue;
    let from = m.index + 1;
    while (from < s.length && isSpace(s.charCodeAt(from))) from++;
    const r = redact(s.slice(nameStart, nameEnd), s.slice(nameEnd, from), from, s);
    if (!r) continue;
    out += s.slice(last, nameStart) + r.text;
    last = r.end;
    SEPARATOR.lastIndex = r.end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * Rewrites the spans `redact` takes over. It is given each `open` match; null leaves the match alone and scanning goes on right
 * after it, so a name that is no secret never swallows what follows it.
 */
function rewrite(s: string, open: RegExp, redact: (m: RegExpExecArray) => { text: string; end: number } | null): string {
  open.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const r = redact(m);
    if (!r) continue;
    out += s.slice(last, m.index) + r.text;
    last = r.end;
    open.lastIndex = r.end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * Where the JSON string that starts at `from` ends when its quotes are escaped `k` times: the first quote preceded by exactly `k`
 * backslashes, else the end of the line (a cut-off value). One pass, so many keys on one long line stay linear.
 * `end` is where the value stops, `next` where scanning resumes.
 */
function stringEnd(s: string, from: number, k: number): { end: number; next: number; closed: boolean } {
  let run = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) run++;
    else if (c === 34 && run === k) return { end: i - k, next: i + 1, closed: true };
    else if (c === 10) return { end: i, next: i, closed: false };
    else run = 0;
  }
  return { end: s.length, next: s.length, closed: false };
}

/**
 * Applied in this order: a JWT after `Bearer` counts as a bearer token, `sk-ant-` before the generic `sk-`, the header and flag
 * shapes before the generic assignment (which then skips what already carries a marker). `keep` rebuilds the match around the marker.
 */
const SECRET_PATTERNS: [kind: string, re: RegExp, keep?: (mark: string, g1: string, g2: string) => string][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ["hub-token", /\btpu_[A-Za-z0-9_-]{20,}/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g],
  ["basic", /(\bauthorization\s*[:=]\s*["']?)Basic\s+[A-Za-z0-9+/=._~-]{4,}/gi, (mark, g1) => `${g1}${mark}`],
  // Any scheme (`Token x`, `ApiKey x`, `Digest …`): the whole value goes, the header name stays.
  ["authorization", /(\b(?:proxy-)?authorization[ \t]*[:=][ \t]*\\*["']?)(?!«redacted:|[ \t])[^\r\n"'\\&]+/gi, (mark, g1) => `${g1}${mark}`],
  // The whole value of the header, `a=b; c=d` included.
  ["cookie", /((?<![A-Za-z0-9_])(?:set-)?cookie[ \t]*:[ \t]*)(?!«redacted:|[ \t])[^\r\n"'\\]+/gi, (mark, g1) => `${g1}${mark}`],
  ["flag-secret", new RegExp(String.raw`((?:^|[^A-Za-z0-9_-])--(?:[A-Za-z0-9]+[_-])*(?:password|passwd|token|secret|api[_-]?key)(?:=|[ \t]+(?!-)))(?!«redacted:)(?:${VALUE_SOURCE})`, "gi"), (mark, g1) => `${g1}${mark}`],
  // curl `-u user:pass`: the user stays. A purely numeric password is a `docker -u uid:gid` pair, not a credential.
  ["curl-user", /((?:^|[^A-Za-z0-9_-])(?:-u|--user)(?:[ \t]+|=)\\*["']?[^\s:"'\\]*:)(?!«redacted:|\d+(?![^\s"'\\]))[^\s"'\\]+/g, (mark, g1) => `${g1}${mark}`],
  // The user may be empty (`redis://:pw@host`); the scheme is capped so a long dotted word cannot make the scan quadratic.
  ["url-credentials", /\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/@:'"«]*:[^\s/@'"]+|[A-Za-z0-9_.-]{20,})(@)/gi, (mark, g1, g2) => `${g1}${mark}${g2}`],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g],
  ["sk-ant", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["sk", /\bsk-[A-Za-z0-9_-]{16,}/g],
  ["stripe", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["gitlab", /\bglpat-[A-Za-z0-9_-]{16,}/g],
  ["npm", /\bnpm_[A-Za-z0-9]{30,}/g],
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}/g],
  ["aws", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["google-oauth", /\bya29\.[A-Za-z0-9_-]{20,}/g],
  ["sendgrid", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ["slack", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
];

/**
 * A literal (lower-case) that must occur in the text for the pattern of that kind to match at all. Regexes that open with a
 * lookbehind or a character class cannot be scanned by literal, so each one costs a full pass over the string: with the anchors
 * absent (nearly always) the pass is skipped, and an indexOf over the text replaces it.
 */
const ANCHORS: Record<string, string[]> = {
  "private-key": ["-----begin"],
  "hub-token": ["tpu_"],
  bearer: ["bearer"],
  basic: ["basic"],
  authorization: ["authorization"],
  cookie: ["cookie"],
  "flag-secret": ["--"],
  "curl-user": ["-u"],
  "url-credentials": ["://"],
  jwt: ["eyj"],
  "sk-ant": ["sk-ant-"],
  sk: ["sk-"],
  stripe: ["k_live_", "k_test_"],
  github: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
  gitlab: ["glpat-"],
  npm: ["npm_"],
  huggingface: ["hf_"],
  aws: ["akia", "asia"],
  google: ["aiza"],
  "google-oauth": ["ya29."],
  sendgrid: ["sg."],
  slack: ["xox"],
};
/** Every secret name ends in one of these (`api_key`, `access-key`, `AccountKey` contain `key`). */
const NAME_ANCHORS = ["token", "secret", "password", "passwd", "authorization", "key", "credential", "cookie", "session", "sid"];

export function createRedactor(ctx: RedactContext): Redactor {
  const replaced: Record<string, number> = {};
  const count = (kind: string, n = 1): void => {
    replaced[kind] = (replaced[kind] ?? 0) + n;
  };

  const prefixes: { dir: string; kind: string; to: string }[] = [];
  const add = (dir: string | undefined, kind: string, to: string): void => {
    const clean = dir?.replace(/\/+$/, "");
    if (clean && clean.length > 1 && clean.startsWith("/")) prefixes.push({ dir: clean, kind, to });
  };
  for (const repo of ctx.repos ?? []) add(repo, "repo", "<repo>");
  add(ctx.dataDir, "data", "<data>");
  for (const tmp of ctx.tmpDirs ?? []) add(tmp, "tmp", "<tmp>");
  add(ctx.home, "home", "~");
  // Longest first: a repo inside the home dir must become <repo>, not ~/…
  prefixes.sort((a, b) => b.dir.length - a.dir.length);
  const byDir = new Map(prefixes.map((p) => [p.dir, p]));
  const prefixRe = prefixes.length
    ? new RegExp(`${SEP}(?:${prefixes.map((p) => pathSource(p.dir).slice(SEP.length)).join("|")})${PATH_CHAR_AFTER}`, "g")
    : null;
  const userRe = accountName(ctx.user);
  const deviceIds = [...new Set((ctx.devices ?? []).filter((id) => id.length >= 4))].sort((a, b) => b.length - a.length);
  const deviceRe = deviceIds.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${deviceIds.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`, "gi") : null;

  /** The literal each configured directory ends in: a text with none of them cannot hold the directory. */
  const dirLiterals = [...new Set(prefixes.map((p) => p.dir.slice(p.dir.lastIndexOf("/") + 1)))].filter(Boolean);
  const deviceLower = deviceIds.map((id) => id.toLowerCase());

  function text(input: string): string {
    let s = input;
    let lower: string | null = null;
    const mentions = (needles: readonly string[]): boolean => {
      lower ??= s.toLowerCase();
      return needles.some((n) => lower!.includes(n));
    };
    const swap = (next: string): void => {
      if (next !== s) {
        s = next;
        lower = null;
      }
    };
    // The known dirs first: a repo that lives in a temp folder is <repo>, not <tmp>/…
    if (prefixRe && dirLiterals.some((d) => s.includes(d))) {
      swap(
        replacePaths(s, prefixRe, (dir) => {
          const p = byDir.get(dir.replace(/%2f/gi, "/"))!;
          count(p.kind);
          return p.to;
        }),
      );
    }
    if (s.includes("folders")) swap(replacePaths(s, MAC_TEMP, () => (count("tmp"), "<tmp>")));
    if (s.includes("Users") || s.includes("home")) swap(replacePaths(s, OTHER_HOME, () => (count("home-other"), "~other")));
    if (userRe && s.includes(ctx.user!)) swap(s.replace(userRe, () => (count("user"), "<user>")));
    if (deviceRe && mentions(deviceLower)) swap(s.replace(deviceRe, () => (count("device"), "<device>")));
    for (const [kind, re, keep] of SECRET_PATTERNS) {
      if (!mentions(ANCHORS[kind]!)) continue;
      swap(
        s.replace(re, (_whole, g1: string, g2: string) => {
          count(kind);
          return keep ? keep(marker(kind), g1, g2) : marker(kind);
        }),
      );
    }
    if (!mentions(NAME_ANCHORS)) return s;
    // `name=value`, `name: value`, `client_secret='two words'`: the name and the separator stay, the value goes.
    s = assignments(s, (name, sep, from, text) => {
      if (!isSecretName(name) || text.startsWith(REDACTED_PREFIX, from)) return null;
      ASSIGNED_VALUE.lastIndex = from;
      const v = ASSIGNED_VALUE.exec(text);
      if (!v) return null;
      let raw = v[0];
      if (!/^["'\\]/.test(raw)) {
        // A bare value is never markup (`**Token:** x`) and does not swallow the markup that closes around it (`**token=x**`).
        if (/^(?:\*|__|`)/.test(raw)) return null;
        raw = raw.replace(/(?:\*+|_{2,}|`+)$/, "");
        // After a colon a broad name is a label, not an assignment: only a token-looking word counts (`Session: logged in` is prose).
        if (BROAD_NAME.test(name) && !sep.includes("=") && !TOKEN_LOOKING.test(raw)) return null;
      }
      if (raw === "") return null;
      count("secret-assignment");
      return { text: `${name}${sep}${marker("secret-assignment")}`, end: from + raw.length };
    });
    // `"name":"value"` as JSON, JSON inside a JSON string, and so on.
    if (!s.includes('"')) return s;
    return rewrite(s, FIELD_OPEN, (m) => {
      const [whole, bs = "", name = ""] = m;
      const from = m.index + whole.length;
      if (!isSecretName(name) || s.startsWith(REDACTED_PREFIX, from)) return null;
      const { end, next, closed } = stringEnd(s, from, bs.length);
      if (end === from) return null;
      count("secret-field");
      return { text: `${whole}${marker("secret-field")}${closed ? `${bs}"` : ""}`, end: next };
    });
  }

  function value<T>(v: T): T {
    if (typeof v === "string") return text(v) as T;
    if (Array.isArray(v)) return v.map((item) => value(item)) as T;
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) {
        if (typeof item === "string" && isSecretName(key) && !item.startsWith(REDACTED_PREFIX)) {
          count("secret-field");
          out[key] = marker("secret-field");
        } else out[key] = value(item);
      }
      return out as T;
    }
    return v;
  }

  return { text, value, replaced };
}
