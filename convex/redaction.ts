// What Threadbear scrubs from anything it sends to Convex. This file has two
// byte-identical copies, runner/src/redaction.ts and convex/redaction.ts (a
// unit test keeps them equal): the runner scrubs before upload, and the
// backend scrubs again before storing, so an older runner can't put a known
// secret shape in the deployment. So no Node or Convex imports here.
//
// The rules come from Agent Archive's shared/redaction.ts (v4, plus its DER
// header rule), where each one was added after a real leak. They only know
// the shapes they know: docs/on-your-mac.md says so, and a key that leaked
// has to be rotated whatever happens here.

// Changing a rule changes what's stored, so bump this. Nothing re-sends for
// it: `runner/scripts/scrub-stored.mjs` rewrites what's already stored.
export const SCRUB_RULES_VERSION = 1;

const REDACTED = "[REDACTED]";

type SecretRule =
  | RegExp
  | {
      pattern: RegExp;
      replace: (match: string, ...groups: string[]) => string;
    }
  | ((text: string) => string);

// The last word of a variable or field name that holds a credential, as in
// AGENT_ARCHIVE_ENROLLMENT_SECRET, refreshToken or "password". Names that only
// mention one, such as tokenExpiresAt or SECRET_NAME, do not qualify.
const SECRET_LAST_WORDS = new Set([
  "secret",
  "password",
  "passwd",
  "passphrase",
  "token",
  "dsn",
  "apikey",
]);
const SECRET_KEY_QUALIFIERS = new Set([
  "private",
  "api",
  "secret",
  "signing",
  "access",
  "encryption",
]);

export function nameHoldsSecret(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  const last = words[words.length - 1];
  const previous = words[words.length - 2];
  return (
    last !== undefined &&
    // EXPO_PUBLIC_* and NEXT_PUBLIC_* values ship in client bundles.
    !words.includes("public") &&
    (SECRET_LAST_WORDS.has(last) ||
      (last === "key" &&
        previous !== undefined &&
        SECRET_KEY_QUALIFIERS.has(previous)))
  );
}

// True for values that refer to a secret instead of containing one, so code
// like `apiKey: process.env.API_KEY` or `token: RefreshToken` stays readable:
// camelCase, PascalCase or snake_case identifiers, ENV_VAR_NAMES, digits only,
// shell and template references, <placeholders>, already masked values, and
// unquoted member access.
function refersToSecret(value: string, quoted: boolean): boolean {
  return (
    /^(?:[A-Za-z][a-z]*(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|\d+)$/.test(
      value,
    ) ||
    /^(?:\$|\{\{|\[REDACTED|<[^>]*>$)/.test(value) ||
    /\*{4,}/.test(value) ||
    (!quoted && /^[A-Za-z_$][\w$]*\??\.[A-Za-z_$]/.test(value))
  );
}

// One or more key lines, each a whole word of 16+ base64 characters with a
// lowercase letter, so ALL_CAPS names never match. A line may follow a quote,
// and lines are separated by whitespace or a literal \n or \r, as in
// JSON-escaped text.
const PEM_BODY_LINES =
  /(?<=^|[\s'"]|\\[nr])(?=[A-Z0-9+/=]*[a-z])[A-Za-z0-9+/=]{16,}(?![\w+/=-])(?:(?:\s|\\[nr])+(?=[A-Z0-9+/=]*[a-z])[A-Za-z0-9+/=]{16,}(?![\w+/=-]))*/g;

// How the base64 of an unencrypted private key starts, whatever its length
// bytes: RSA PKCS#8 and PKCS#1, EC PKCS#8 (Apple .p8 keys among them) and
// SEC1, Ed25519 and X25519 PKCS#8, and openssh-key-v1.
const PRIVATE_KEY_DER_HEADERS = [
  "MII[A-Za-z0-9+/]{3}IBADANBgkqhkiG9w0BAQEF",
  "MII[A-Za-z0-9+/]{3}IBAAKC",
  "MI[GH][A-Za-z0-9+/]AgEAMB[AM]GByqGSM49AgEG",
  "MHcCAQEEI",
  "MIGkAgEBBDA",
  "MIHcAgEBBEI",
  "MC4CAQAwBQYDK2V[uw]",
  "b3BlbnNzaC1rZXktdjEA",
];

// Whole PEM private keys. By hand rather than a regex: a regex retried its
// search for the END line from every BEGIN, so a text of unclosed BEGIN lines
// took quadratic time, on the runner's event loop or in a mutation. Every END
// line is found once, up front.
function redactPemBlocks(text: string): string {
  if (!text.includes("PRIVATE KEY-----")) return text;
  const ends = new Map<string, { at: number[]; next: number }>();
  for (const m of text.matchAll(/-----END ([A-Z0-9 ]{0,40})PRIVATE KEY-----/g)) {
    const label = m[1] ?? "";
    const list = ends.get(label) ?? { at: [], next: 0 };
    list.at.push(m.index ?? 0);
    ends.set(label, list);
  }
  if (!ends.size) return text;
  const begin = /-----BEGIN ([A-Z0-9 ]{0,40})PRIVATE KEY-----/g;
  let out = "";
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = begin.exec(text))) {
    const label = m[1] ?? "";
    const list = ends.get(label);
    if (!list) continue;
    while (list.next < list.at.length && (list.at[list.next] ?? 0) < begin.lastIndex) list.next++;
    const end = list.at[list.next];
    if (end === undefined) continue;
    out += text.slice(from, m.index) + "[REDACTED PRIVATE KEY]";
    from = end + `-----END ${label}PRIVATE KEY-----`.length;
    begin.lastIndex = from;
  }
  return from === 0 ? text : out + text.slice(from);
}

const secretRules: SecretRule[] = [
  // Version 1 rules. They stay first and unchanged so text they already
  // redacted keeps the archived content hash.
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)\s*[=:]\s*[^\s"']{12,}/gi,

  // PEM private keys: the whole block, or the base64 body when the END line
  // was cut off.
  redactPemBlocks,
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\s|\\[nr])*(?:[A-Za-z0-9+/=]{16,}(?:\s|\\[nr])*)+/g,
    replace: () => "[REDACTED PRIVATE KEY]",
  },
  // PEM key bodies whose BEGIN line was stripped, for example by
  // `convex env list | sed 's/=.*//' | sort`, which leaves the key lines in
  // any order among ENV_VAR_NAMES, next to the quotes env list puts around
  // multi-line values. Any run of words that holds an END ... PRIVATE KEY line
  // loses its key lines; the names, quotes and the END line stay. Words are
  // separated by whitespace, quotes, escaped quotes or a literal \n or \r. A
  // run may only start where the previous character can't continue one, so
  // each run is scanned once and long runs without an END line stay linear.
  {
    pattern:
      /(?<![\w+/=\\\s'"-])(?:[\s'"]|\\[nr'"])*(?:[\w+/=-]+(?:[\s'"]|\\[nr'"])+)*?-----END [A-Z0-9 ]*PRIVATE KEY-----(?:(?:[\s'"]|\\[nr'"])+[\w+/=-]+)*/g,
    replace: (run) => run.replace(PEM_BODY_LINES, "[REDACTED PRIVATE KEY]"),
  },
  // Private keys known by the DER header their base64 always starts with,
  // for copies the rules above miss because neither PEM line survived whole.
  // On 8 Oct 2026 a truncating env listing turned the BEGIN line into
  // "-----BE..." and put "..." in front of the END line, and a whole Google
  // service account key went into the archive. The match carries on over the
  // key's later lines, wherever newlines, escaped newlines, quotes, commas,
  // diff markers or line numbers separate them.
  {
    pattern: new RegExp(
      String.raw`(?<=^|[^A-Za-z0-9+/=]|\\[nr])` +
        `(?:${PRIVATE_KEY_DER_HEADERS.join("|")})[A-Za-z0-9+/=]{20,}` +
        String.raw`(?:(?:\s|\\+[nrt"']|["'\x60,|>]|\.{3}|…|\+(?=[\s\\"'])|\d{1,6}(?:\t|→))+[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9+/=]))*`,
      "g",
    ),
    replace: () => "[REDACTED PRIVATE KEY]",
  },
  // Threadbear's own phone and browser tokens (convex/tokens.ts).
  /(?<![A-Za-z0-9_])tbr?_[0-9a-f]{32,}(?![0-9a-f])/g,
  // Agent Archive device tokens.
  /(?<![A-Za-z0-9_])aa_[a-f0-9]{16}_[A-Za-z0-9_-]{32,}/g,
  // Convex deploy keys such as prod:name|token or preview:team:project|token.
  /\b(?:prod|dev|preview|project):[A-Za-z0-9_-]{1,128}(?::[A-Za-z0-9_-]{1,128}){0,6}\|[A-Za-z0-9+/=_-]{20,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,512}\.eyJ[A-Za-z0-9_-]{8,65536}\.[A-Za-z0-9_-]{16,}/g,
  // Stripe, Slack, Google, GitHub and npm credential shapes.
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9+/=]{24,}/g,
  /\bxapp-[A-Za-z0-9-]{16,}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // Passwords embedded in connection URLs, such as postgres://user:pw@host.
  {
    // The lookbehind and bounded scheme length keep this linear on long
    // runs like "ab-ab-ab-...", which a plain \b start rescans quadratically.
    pattern:
      /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/"']+:)([^\s@/"']{8,})(@)/gi,
    replace: (_match, before, _password, at) => `${before}${REDACTED}${at}`,
  },
  // macOS Keychain passwords on the command line: security
  // add-generic-password ... -w <password>, or unlock-keychain -p <password>.
  // Bounded, as without a limit a long line of these took minutes (quadratic);
  // no real command has its password 500 characters along.
  {
    pattern:
      /(\bsecurity\s+(?:add-(?:generic|internet)-password\b[^\n]{0,500}?\s-w|(?:unlock|create)-keychain\b[^\n]{0,500}?\s-p)\s+)("[^"\n]*"|'[^'\n]*'|(?!-)[^\s"']+)/g,
    replace: (_match, command) => `${command}${REDACTED}`,
  },
  // More provider token shapes with distinctive prefixes.
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:secret|ntn)_[A-Za-z0-9]{40,}\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}\b/g,
  /\bsbp_[a-f0-9]{40}\b/g,
  /\bdop_v1_[a-f0-9]{64}\b/g,
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g,
  /\bpypi-[A-Za-z0-9_-]{50,}/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
  // HTTP Basic credentials in headers.
  {
    pattern: /(\bBasic\s+)[A-Za-z0-9+/]{16,}={0,2}/g,
    replace: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  // Assignments and fields whose name marks a credential, for example
  // AGENT_ARCHIVE_ENROLLMENT_SECRET=..., AUTH_PRIVATE_KEY="..." or JSON
  // "password": "...". Only the value is replaced.
  {
    pattern:
      /(?<![A-Za-z0-9_.])(["']?)([A-Za-z][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)(?:"((?:[^"\\\n]|\\.){12,})"|'([^'\n]{12,})'|\\"([^"\\\n]{12,})\\"|([^\s"'`,;(){}[\]<>\\]{12,}))/g,
    replace: (match, quote, name, separator, ...values) => {
      const [doubleQuoted, singleQuoted, escapedQuoted, bare] = values;
      const value = doubleQuoted ?? singleQuoted ?? escapedQuoted ?? bare ?? "";
      if (!nameHoldsSecret(name) || refersToSecret(value, bare === undefined)) {
        return match;
      }
      const redactedValue =
        doubleQuoted !== undefined
          ? `"${REDACTED}"`
          : singleQuoted !== undefined
            ? `'${REDACTED}'`
            : escapedQuoted !== undefined
              ? `\\"${REDACTED}\\"`
              : REDACTED;
      return `${quote}${name}${quote}${separator}${redactedValue}`;
    },
  },
];

// A key the runner's summary code cut short: a title or preview ends part way
// through one, too short for the rules above and still most of a key. Threadbear's
// own addition. Only at the very end of the text, and only in its last stretch so
// a long text costs nothing, with a prefix that's clearly a credential's. Ones
// that can start an ordinary name (hf_transfer, npm_registry) need a digit or
// a length no name has.
const CUT_SHORT = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?:` +
    [
      String.raw`(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}`,
      String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{4,}`,
      String.raw`gh[pousr]_[A-Za-z0-9]{8,}`,
      String.raw`github_pat_[A-Za-z0-9_]{8,}`,
      String.raw`xox[baprs]-[A-Za-z0-9-]{8,}`,
      String.raw`xapp-[A-Za-z0-9-]{8,}`,
      String.raw`AKIA[0-9A-Z]{8,}`,
      String.raw`AIza[0-9A-Za-z_-]{8,}`,
      String.raw`GOCSPX-[A-Za-z0-9_-]{8,}`,
      String.raw`whsec_[A-Za-z0-9+/=]{8,}`,
      String.raw`(?:npm|hf|secret|ntn)_(?:(?=[A-Za-z]*\d)[A-Za-z0-9]{8,}|[A-Za-z0-9]{20,})`,
      String.raw`glpat-[A-Za-z0-9_-]{8,}`,
      String.raw`lin_(?:api|oauth)_[A-Za-z0-9]{8,}`,
      String.raw`sbp_[a-f0-9]{8,}`,
      String.raw`dop_v1_[a-f0-9]{8,}`,
      String.raw`shp(?:at|ss|ca|pa)_[a-fA-F0-9]{8,}`,
      String.raw`pypi-[A-Za-z0-9_-]{8,}`,
      String.raw`tbr?_[0-9a-f]{8,}`,
      String.raw`aa_[a-f0-9]{8,}(?:_[A-Za-z0-9_-]*)?`,
      String.raw`\d{8,10}:AA[A-Za-z0-9_-]{4,}`,
      String.raw`eyJ[A-Za-z0-9_.-]{8,}`,
      String.raw`Bearer\s+[A-Za-z0-9._~+/=-]{8,}`,
    ].join("|") +
    // What a cut leaves after it: an ellipsis, or the mark on a long message.
    String.raw`)((?:…|\.\.\.|\n\n\[cut: [^\]\n]*\](?:\n\n\[\d+ pictures?\])?)?\s*)$`,
);
secretRules.push((text) => {
  const from = Math.max(0, text.length - 600);
  const tail = text.slice(from);
  const out = tail.replace(CUT_SHORT, (_m, after: string) => `${REDACTED}${after}`);
  return out === tail ? text : text.slice(0, from) + out;
});

export function redactSecrets(value: string): {
  text: string;
  redacted: boolean;
} {
  let text = value;
  for (const rule of secretRules) {
    text =
      typeof rule === "function"
        ? rule(text)
        : rule instanceof RegExp
          ? text.replace(rule, REDACTED)
          : text.replace(rule.pattern, rule.replace);
  }
  return { text, redacted: text !== value };
}

// Fields that are a row's identity or a machine's words, never free text:
// scrubbing one would lose the row it names. `key` is the runner key on a
// mutation and a public key on a secret card. Timestamps are skipped for speed.
const NOT_TEXT = new Set([
  "key",
  "threadId",
  "resultThreadId",
  "runnerId",
  "id",
  "commandId",
  "storageId",
  "scheduleId",
  "approvalId",
  "projectId",
  "accountId",
  "poolId",
  "slug",
  "holder",
  "expect",
  "picture",
  "turn",
  "at",
  "hash",
  "keyHash",
  // Folders, as they're looked up: a schedule or a pool with its path changed
  // stops working.
  "cwd",
  "folders",
  // Words a validator checks against a list. A known value that happens to be
  // one ("question" as a password) mustn't turn it into something it refuses.
  "kind",
  "role",
  "status",
  "view",
  "access",
]);

// Nothing the rules or a known value could match is shorter than this.
const SHORTEST = 8;

// What's stored instead of text whose check threw: it doesn't go up, and the
// mark says why. The runner's status counts them.
export const HELD_BACK = "[held back: the secret check failed]";

export type Scrub = (text: string) => string;

export const scrubText: Scrub = (text) => redactSecrets(text).text;

// A copy of `value` with every free-text string scrubbed. Hands back the same
// object when nothing changed, so a caller can tell, and allocates nothing for
// a clean row. Never throws: a string whose check fails is held back, so one
// bad value can't stop a write or slip through it.
export function scrubDoc<T>(
  value: T,
  scrub: Scrub = scrubText,
  onFailure?: (error: unknown) => void,
): T {
  const leaf = (text: string): string => {
    if (text.length < SHORTEST) return text;
    try {
      return scrub(text);
    } catch (error) {
      onFailure?.(error);
      return HELD_BACK;
    }
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return leaf(v);
    if (Array.isArray(v)) {
      let out: unknown[] | undefined;
      v.forEach((item, i) => {
        const next = walk(item);
        if (next !== item) (out ??= [...v])[i] = next;
      });
      return out ?? v;
    }
    if (v === null || typeof v !== "object") return v;
    // Only plain objects: an ArrayBuffer or the like isn't text.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    let out: Record<string, unknown> | undefined;
    for (const [k, item] of Object.entries(v)) {
      // A command's answers are keyed by question, in the question's words, so
      // here a key is text and no key name means anything.
      if (k === "answers" && item && typeof item === "object" && !Array.isArray(item)) {
        const map = Object.entries(item);
        const clean = map.map(([q, a]) => [leaf(q), walkAny(a)] as const);
        if (clean.some(([q, a], i) => q !== map[i]?.[0] || a !== map[i]?.[1])) {
          (out ??= { ...(v as Record<string, unknown>) })[k] = Object.fromEntries(clean);
        }
        continue;
      }
      if (NOT_TEXT.has(k) || k.endsWith("At")) continue;
      const next = walk(item);
      if (next !== item) (out ??= { ...(v as Record<string, unknown>) })[k] = next;
    }
    return out ?? v;
  };
  const walkAny = (a: unknown): unknown => (typeof a === "string" ? leaf(a) : walk(a));
  return walk(value) as T;
}

// Every string in parsed JSON, whatever its field is called. For a call's answer,
// which isn't a row: NOT_TEXT's field names mean nothing in it, and could hide a
// value under `key` or `cwd`.
//
// Text scrubbed a string at a time loses what a field's name says about it, so a
// value under a name that holds a secret goes whatever it looks like: the rules
// only know `password: "..."` when they can see both.
export function scrubEveryString(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubEveryString(item, scrub));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, item]) => [
        scrub(k),
        nameHoldsSecret(k) ? secretField(item, scrub) : scrubEveryString(item, scrub),
      ]),
    );
  }
  return value;
}

// A value under a name like `password`. Only what plainly points elsewhere stays:
// $VAR, {{var}}, <placeholder>, a masked value, process.env.X and the like, or a
// variable's NAME. Numbers go too, as a PIN is one.
function secretField(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "number") return REDACTED;
  if (typeof value === "string") {
    if (!value) return value;
    const pointsElsewhere =
      /^(?:\$|\{\{|\[REDACTED|<[^>]*>$)/.test(value) ||
      /\*{4,}/.test(value) ||
      /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) ||
      /^(?:process\.env|import\.meta\.env|env|config|settings|args|opts|options|ctx|this|self)(?:\??\.[A-Za-z_$][\w$]*)+$/.test(value);
    // Scrubbed even so: a known value can look like one of those.
    return pointsElsewhere ? scrub(value) : REDACTED;
  }
  if (Array.isArray(value)) return value.map((v) => secretField(v, scrub));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), secretField(v, scrub)]));
  return value;
}
