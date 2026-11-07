// Turns the raw `codex app-server` captures (runner/.fixtures/codex-raw/,
// gitignored: they hold Mike's account id, credit balances, home paths,
// hostname and private hook text) into the committed fixtures under
// runner/test/fixtures/codex/.
//
//   node scripts/sanitize-codex-recording.ts [--raw DIR] [--out DIR] [--only NAME]
//
// It reads both capture formats (drive.mjs's and the spikes' {dir, t, msg}
// lines, and probe.mjs's {t, dir, method|response|serverRequest} records),
// rewrites what's private, and fails loudly if anything that looks private
// is still there afterwards: an email, a /Users/ path, an account id, a
// value it was told to drop, this Mac's user or host name, a long base64
// string or a truncation marker. Fixtures are written as {proc, dir, t, msg}
// lines; `proc` tells one app-server process from the next (a resume).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePng } from '../test/helpers/png.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
export type Rec = { proc: string; dir: 'in' | 'out'; t?: number; msg: Obj };

// A tiny real PNG (4 x 4, blue) that stands in for every base64 image.
export const TINY_PNG_B64 = makePng(4, 4, [30, 60, 220]).toString('base64');

// Where the temp folders the captures ran in go. Every capture ran in
// /tmp/tb-<something> (or its /private/tmp form), in a run/, probe/, a/ or
// b/ folder or the folder itself.
const WORK = '/work/proj';
const TMP_DIR = /(?:\/private)?\/tmp\/tb-[^/"'\s]+(?:\/(?:run|probe|a|b)(?=[/"'\s:]|$))?/g;
const CODEX_HOME = /\/Users\/[^/"'\s]+\/\.codex/g;

// Requests whose replies are big and say nothing a fixture needs (the MCP
// and feature lists), dropped with their replies.
const DROP_REQUESTS = new Set(['mcpServerStatus/list', 'experimentalFeature/list', 'thread/loaded/list']);
const DROP_NOTIFICATIONS = new Set(['turn/moderationMetadata']);

// Keys whose values are private wherever they appear: dropped, and their
// values remembered so the leak check can look for them anywhere else.
const DROP_KEYS = new Set(['accountId', 'chatgptAccountId', 'workspaceRouting', 'email', 'rateLimitResetCredits', 'rateLimitUpsell']);
const HARVEST_KEYS = new Set(['accountId', 'chatgptAccountId', 'installationId', 'serverName', 'email']);

// Reads one capture file into records, whichever format it's in.
export function readCapture(file: string, defaultProc = 'A'): Rec[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => toRec(JSON.parse(line) as Obj, defaultProc))
    .filter((r): r is Rec => r !== null);
}

function toRec(r: Obj, defaultProc: string): Rec | null {
  const proc = typeof r.proc === 'string' ? r.proc : defaultProc;
  const t = typeof r.t === 'number' ? r.t : undefined;
  const dir = r.dir === 'out' ? 'out' : 'in';
  if (r.msg && typeof r.msg === 'object' && !Array.isArray(r.msg)) return { proc, dir, t, msg: r.msg as Obj };
  // probe.mjs's records.
  if ('historyItems' in r) return null;
  if ('response' in r) {
    const msg: Obj = { id: r.response };
    if (r.error !== undefined && r.error !== null) msg.error = r.error;
    else msg.result = r.result ?? null;
    return { proc, dir: 'in', t, msg };
  }
  if ('serverRequest' in r) return { proc, dir: 'in', t, msg: { id: r.id, method: r.serverRequest, params: r.params ?? null } };
  if (typeof r.method === 'string') {
    const msg: Obj = { method: r.method };
    if (r.id !== undefined) msg.id = r.id;
    if (r.params !== undefined) msg.params = r.params;
    return { proc, dir, t, msg };
  }
  return null;
}

// Picks 1-based inclusive line ranges out of a capture.
export function pickLines(file: string, ranges: [number, number][], proc = 'A'): Rec[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out: Rec[] = [];
  for (const [a, b] of ranges) {
    for (let i = a; i <= Math.min(b, lines.length); i++) {
      if (!lines[i - 1]) continue;
      const r = toRec(JSON.parse(lines[i - 1]) as Obj, proc);
      if (r) out.push({ ...r, proc });
    }
  }
  return out;
}

export type SanitizeResult = { records: Rec[]; secrets: string[] };

// Drops the records a fixture doesn't need and rewrites what's private in
// the rest. The values of the private keys it drops are returned, so the
// caller can check they appear nowhere in the output.
export function sanitizeRecords(records: Rec[]): SanitizeResult {
  const secrets = new Set<string>();
  const dropIds = new Map<string, Set<Json>>(); // proc -> request ids whose replies go too
  const kept: Rec[] = [];
  for (const r of records) {
    const m = r.msg;
    const method = typeof m.method === 'string' ? m.method : undefined;
    if (r.dir === 'out' && method && DROP_REQUESTS.has(method)) {
      if (!dropIds.has(r.proc)) dropIds.set(r.proc, new Set());
      dropIds.get(r.proc)!.add(m.id ?? null);
      continue;
    }
    if (r.dir === 'in' && !method && dropIds.get(r.proc)?.has(m.id ?? null)) continue;
    if (method && DROP_NOTIFICATIONS.has(method)) continue;
    harvest(m, secrets);
    kept.push({ ...r, msg: scrub(m, []) as Obj });
  }
  return { records: kept, secrets: [...secrets].filter((s) => s.length >= 6) };
}

function harvest(v: Json, out: Set<string>): void {
  if (Array.isArray(v)) v.forEach((x) => harvest(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (HARVEST_KEYS.has(k) && typeof x === 'string' && x !== '[REDACTED]') out.add(x);
      harvest(x, out);
    }
  }
}

function scrub(v: Json, keys: string[]): Json {
  const key = keys[keys.length - 1] ?? '';
  if (typeof v === 'string') return scrubString(v, key);
  if (Array.isArray(v)) {
    if (key === 'instructionSources') return v.map((x) => (typeof x === 'string' ? x.replace(CODEX_HOME, '~/.codex').replace(TMP_DIR, WORK) : x));
    return v.map((x) => scrub(x, keys));
  }
  if (!v || typeof v !== 'object') return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'codexHome') out[k] = '/codex-home';
    else if (k === 'installationId' && typeof x === 'string') out[k] = '00000000-0000-0000-0000-000000000000';
    else if (k === 'serverName' && typeof x === 'string') out[k] = 'mac.local';
    else if (k === 'balance' && typeof x === 'string' && key === 'credits') out[k] = '1234.5000000000';
    else if (k === 'text' && keys.includes('entries') && keys.includes('run')) out[k] = '[hook context removed]';
    else if (k === 'sourcePath' && key === 'run') out[k] = '~/.codex/hooks.json';
    else if (k === 'statusMessage' && key === 'run' && typeof x === 'string') out[k] = 'Running a hook';
    else out[k] = scrub(x, [...keys, k]);
  }
  return out;
}

function scrubString(s: string, key: string): string {
  if (key === 'userAgent') s = s.replace(/\((?:Mac OS|macOS)[^)]*\)/, '(macOS; arm64)');
  if (s.length > 1000 && isBase64(s)) return TINY_PNG_B64;
  const dataUrl = /^data:(image\/[\w.+-]+);base64,/.exec(s);
  if (dataUrl && s.length > 1000) return `data:image/png;base64,${TINY_PNG_B64}`;
  return s
    .replace(CODEX_HOME, '/codex-home')
    .replace(TMP_DIR, WORK)
    .replace(/(https?:\/\/(?:127\.0\.0\.1|localhost)):\d+/g, '$1:1234');
}

function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s.slice(0, 4000)) && /^[A-Za-z0-9+/]*={0,2}$/.test(s.slice(-200));
}

// Problems that mean a fixture isn't safe to commit; empty when it's clean.
export function leaks(text: string, secrets: string[] = [], local = localNames()): string[] {
  const found: string[] = [];
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.exec(text);
  if (email) found.push(`an email address (${email[0]})`);
  const users = /\/Users\/[^"\s]*/.exec(text);
  if (users) found.push(`a /Users/ path (${users[0].slice(0, 60)})`);
  if (/"(?:accountId|chatgptAccountId|workspaceRouting)"/.test(text)) found.push('an account id key');
  const marker = /(?:\.\.\.|…)\s*[[<]\d+ chars[\]>]/.exec(text);
  if (marker) found.push(`a truncation marker (${marker[0]})`);
  for (const s of secrets) if (text.includes(s)) found.push(`a dropped private value (${s.slice(0, 4)}…)`);
  // As a whole name, not inside a word: a login called "vision" isn't in "revision".
  for (const n of local) {
    if (n && new RegExp(`(?<![a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i').test(text)) found.push(`this Mac's user or host name (${n})`);
  }
  const b64 = /[A-Za-z0-9+/]{1500,}={0,2}/g;
  for (const m of text.matchAll(b64)) if (!TINY_PNG_B64.includes(m[0]) && !m[0].includes(TINY_PNG_B64)) found.push(`a long base64 string (${m[0].length} chars)`);
  return found;
}

function localNames(): string[] {
  const names = new Set<string>();
  try {
    names.add(os.userInfo().username);
  } catch {
    // No user name to check for.
  }
  const host = os.hostname().replace(/\.(local|localdomain|lan)$/i, '');
  if (host) names.add(host);
  return [...names].filter((n) => n.length >= 4);
}

export function toNdjson(records: Rec[]): string {
  return records.map((r) => JSON.stringify(r.t === undefined ? { proc: r.proc, dir: r.dir, msg: r.msg } : { proc: r.proc, dir: r.dir, t: r.t, msg: r.msg })).join('\n') + '\n';
}

// The fixtures, from the 27 Oct captures (their README lists every file and
// turn). Each part is a capture, its 1-based inclusive line ranges and the
// process it ran in. The first range of a part is usually the handshake and
// thread/start, so a replay knows its thread.
type Part = { file: string; ranges: [number, number][]; proc?: string };
export const FIXTURES: Record<string, Part[]> = {
  text: [{ file: 'run.ndjson', ranges: [[1, 23]] }],
  'command-and-add': [{ file: 'run.ndjson', ranges: [[1, 6], [24, 69]] }],
  'image-in': [{ file: 'run.ndjson', ranges: [[1, 6], [70, 83]] }],
  interrupt: [{ file: 'run.ndjson', ranges: [[1, 6], [123, 139]] }],
  'update-patch': [{ file: 'run2.ndjson', ranges: [[1, 31]] }],
  approvals: [{ file: 'run2.ndjson', ranges: [[1, 6], [32, 131]] }],
  'approvals-accepted': [{ file: 'spikes/ask-mode-and-reasoning/spike2-ask.ndjson', ranges: [[1, 256]] }],
  failure: [{ file: 'fail.ndjson', ranges: [[1, 19]] }],
  resume: [
    { file: 'resume1.ndjson', ranges: [[1, 24]], proc: 'A' },
    { file: 'resume2.ndjson', ranges: [[1, 37]], proc: 'B' },
  ],
  models: [{ file: 'probe.ndjson', ranges: [[1, 7]] }],
  'image-view': [{ file: 'probe-images.ndjson', ranges: [[1, 19], [21, 24], [37, 38]] }],
  'image-generation': [{ file: 'probe-images.ndjson', ranges: [[1, 19], [26, 38]] }],
  'rate-limits': [
    { file: 'probe.ndjson', ranges: [[1, 2], [8, 11]], proc: 'A' },
    { file: 'probe-images.ndjson', ranges: [[6, 6], [24, 24], [29, 29], [35, 35]], proc: 'A' },
  ],
  reasoning: [
    { file: 'spikes/ask-mode-and-reasoning/spike7-reasoning-longer.ndjson', ranges: [[1, 124]], proc: 'A' },
    { file: 'spikes/ask-mode-and-reasoning/spike7-reasoning.ndjson', ranges: [[1, 5], [26, 41]], proc: 'B' },
  ],
  'dynamic-tools': [
    { file: 'spikes/tools-and-env/start.ndjson', ranges: [[1, 64]], proc: 'A' },
    { file: 'spikes/tools-and-env/resume.ndjson', ranges: [[1, 72]], proc: 'B' },
  ],
  subagent: [{ file: 'spikes/subagents-and-background/subagent.ndjson', ranges: [[1, 62]] }],
  'background-terminal': [{ file: 'spikes/subagents-and-background/background-exit.ndjson', ranges: [[1, 40]] }],
  'real-config': [{ file: 'spikes/real-config-and-mcp/run1/wire.ndjson', ranges: [[1, 49]] }],
};

export function buildFixture(rawDir: string, parts: Part[]): SanitizeResult {
  const records: Rec[] = [];
  for (const part of parts) records.push(...pickLines(path.join(rawDir, part.file), part.ranges, part.proc ?? 'A'));
  return sanitizeRecords(records);
}

function main(argv: string[]): void {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rawDir = path.resolve(arg('--raw') ?? path.join(here, '..', '.fixtures', 'codex-raw'));
  const outDir = path.resolve(arg('--out') ?? path.join(here, '..', 'test', 'fixtures', 'codex'));
  const only = arg('--only');
  if (!fs.existsSync(rawDir)) {
    console.error(`No captures at ${rawDir}. Copy them there first (see docs/step4-plan.md, "Captures").`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let failed = false;
  for (const [name, parts] of Object.entries(FIXTURES)) {
    if (only && name !== only) continue;
    const { records, secrets } = buildFixture(rawDir, parts);
    const text = toNdjson(records);
    const problems = leaks(text, secrets);
    if (problems.length) {
      failed = true;
      console.error(`${name}: not written, it still has ${[...new Set(problems)].join('; ')}`);
      continue;
    }
    fs.writeFileSync(path.join(outDir, `${name}.ndjson`), text);
    console.log(`${name}.ndjson: ${records.length} lines, ${text.length} bytes`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
