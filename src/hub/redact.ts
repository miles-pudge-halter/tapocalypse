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
const PATH_CHAR_BEFORE = String.raw`(?:(?<![A-Za-z0-9_~.-])|(?<=%2[Ff]))`;
const PATH_CHAR_AFTER = String.raw`(?![A-Za-z0-9_~-])`;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The regex source of an absolute path whose `/` also match `%2F`. */
const pathSource = (dir: string): string => dir.split("/").map(escapeRegExp).join(SEP);
// The third segment (`T`, `C`, `0`) and even the second may be missing: activity arguments are truncated mid-path.
const MAC_TEMP = new RegExp(
  `${PATH_CHAR_BEFORE}(?:${SEP}private)?${SEP}var${SEP}folders${SEP}[A-Za-z0-9_]+(?:${SEP}[A-Za-z0-9_]+)?(?:${SEP}[A-Za-z0-9]${PATH_CHAR_AFTER})?`,
  "g",
);
/** Somebody else's home directory (`/Users/<name>`, `/home/<name>`): the user is a stranger to the hub's viewers. */
const OTHER_HOME = new RegExp(`${PATH_CHAR_BEFORE}${SEP}(?:Users|home)${SEP}[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*`, "g");
/** Shared service accounts: not personal, and replacing them would mangle ordinary words ("root cause", "test runner"). */
const GENERIC_ACCOUNTS: Record<string, true> = Object.fromEntries(
  ["root", "admin", "administrator", "user", "runner", "ubuntu", "debian", "ec2-user", "vagrant", "docker", "bun", "node", "app", "ci", "build", "jenkins", "github", "gitlab-runner"].map((name) => [name, true]),
);

/** The account name as a whole word: not part of a longer name, a path segment, or the local part of an email address. */
function accountName(user: string | undefined): RegExp | null {
  if (!user || user.length < 3 || GENERIC_ACCOUNTS[user.toLowerCase()]) return null;
  return new RegExp(`(?<![A-Za-z0-9_.@/-])${escapeRegExp(user)}(?![A-Za-z0-9_@-])`, "g");
}

/** Words that make a name a secret's name: `token`, `API_TOKEN`, `x-api-key`, `client_secret`, `DB_PASSWORD`, `Authorization`. */
const SECRET_WORDS = "token|secret|password|passwd|authorization|api[_-]?key|access[_-]?key|private[_-]?key|credentials?";
const SECRET_KEY = new RegExp(`^(?:[A-Za-z0-9]+[_-])*(?:${SECRET_WORDS})$`, "i");
const SECRET_FIELD = new RegExp(`(\\\\?"(?:[A-Za-z0-9]+[_-])*(?:${SECRET_WORDS})\\\\?"\\s*:\\s*\\\\?")([^"\\\\]+)(\\\\?")`, "gi");
/** `API_TOKEN=value`, `password: value`, `client_secret='two words'`: the name and the separator stay, the value goes. */
const SECRET_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_-])*(?:${SECRET_WORDS}))(\\s*[=:]\\s*)(?!«redacted:)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"',;&]+)`,
  "gi",
);

/** Applied in this order: a JWT after `Bearer` counts as a bearer token, `sk-ant-` before the generic `sk-`. `keep` rebuilds the match around the marker. */
const SECRET_PATTERNS: [kind: string, re: RegExp, keep?: (mark: string, g1: string, g2: string) => string][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["hub-token", /\btpu_[A-Za-z0-9_-]{20,}/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g],
  ["basic", /(\bauthorization\s*[:=]\s*["']?)Basic\s+[A-Za-z0-9+/=._~-]{4,}/gi, (mark, g1) => `${g1}${mark}`],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@:'"«]+:[^\s/@'"]+|[A-Za-z0-9_.-]{20,})(@)/gi, (mark, g1, g2) => `${g1}${mark}${g2}`],
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
  ["secret-assignment", SECRET_ASSIGNMENT, (mark, g1, g2) => `${g1}${g2}${mark}`],
];

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
    ? new RegExp(`${PATH_CHAR_BEFORE}(?:${prefixes.map((p) => pathSource(p.dir)).join("|")})${PATH_CHAR_AFTER}`, "g")
    : null;
  const userRe = accountName(ctx.user);

  function text(input: string): string {
    let s = input;
    // The known dirs first: a repo that lives in a temp folder is <repo>, not <tmp>/…
    if (prefixRe) {
      s = s.replace(prefixRe, (dir) => {
        const p = byDir.get(dir.replace(/%2f/gi, "/"))!;
        count(p.kind);
        return p.to;
      });
    }
    s = s.replace(MAC_TEMP, () => (count("tmp"), "<tmp>"));
    s = s.replace(OTHER_HOME, () => (count("home-other"), "~other"));
    if (userRe) s = s.replace(userRe, () => (count("user"), "<user>"));
    for (const [kind, re, keep] of SECRET_PATTERNS) {
      s = s.replace(re, (_whole, g1: string, g2: string) => {
        count(kind);
        return keep ? keep(marker(kind), g1, g2) : marker(kind);
      });
    }
    return s.replace(SECRET_FIELD, (_whole, open: string, value: string, close: string) => {
      if (value.startsWith("«redacted:")) return `${open}${value}${close}`;
      count("secret-field");
      return `${open}${marker("secret-field")}${close}`;
    });
  }

  function value<T>(v: T): T {
    if (typeof v === "string") return text(v) as T;
    if (Array.isArray(v)) return v.map((item) => value(item)) as T;
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) {
        if (typeof item === "string" && SECRET_KEY.test(key) && !item.startsWith("«redacted:")) {
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
