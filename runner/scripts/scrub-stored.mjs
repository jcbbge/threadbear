#!/usr/bin/env node
// Runs today's secret rules over what's already in the Convex deployment
// (sync:scrubStoredBatch), a small page at a time. For after a rule changes:
// new rows are scrubbed as they arrive, but a stored row stays as it is until
// this runs. Dry run unless you pass --apply. It prints table names, row ids
// and counts, and never what was in a row.
//
//   node runner/scripts/scrub-stored.mjs                     what would change
//   node runner/scripts/scrub-stored.mjs --apply             change it
//   node runner/scripts/scrub-stored.mjs --table messages    one table
//   node runner/scripts/scrub-stored.mjs --batch 100         rows per call (200)
//
// Reading a table costs database I/O for its whole size, about 25 MB for
// Mike's 700 threads, so run it when a rule changes rather than on a timer.
// Copies of the old text can outlive this: Convex backups and snapshot exports
// aren't touched. A key that leaked has to be rotated either way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { credentialUrlProblem } from '../src/secure-url.ts';

export const TABLES = ['messages', 'threads', 'threadIndex', 'projects', 'schedules', 'pocketCards', 'accounts', 'commands', 'replyImages', 'shareImages', 'pools', 'runners', 'tokens', 'runnerKeys', 'runnerStats', 'projectIcons', 'projectHeads', 'projectNotes', 'eventBodies'];

export async function scrubStored({ post, key, tables = TABLES, apply = false, batch = 200, say = () => {} }) {
  const totals = {};
  for (const table of tables) {
    let cursor = null;
    const t = (totals[table] = { scanned: 0, changed: 0, ids: [] });
    for (;;) {
      const r = await post('sync:scrubStoredBatch', { key, table, cursor, apply, limit: batch });
      t.scanned += r.scanned;
      t.changed += r.changed.length;
      t.ids.push(...r.changed);
      t.rulesVersion = r.rulesVersion;
      if (r.done) break;
      cursor = r.cursor;
    }
    say(`${table}: ${t.scanned} rows, ${t.changed} ${apply ? 'changed' : 'would change'}${t.ids.length ? `\n  ${t.ids.join('\n  ')}` : ''}`);
  }
  return totals;
}

// Every call carries the runner key: https (or plain http to this Mac) and
// no redirects, as the runner's own poster (src/sync.ts convexPoster).
function httpPost(url) {
  const base = url.replace(/\/+$/, '');
  const problem = credentialUrlProblem(base);
  if (problem) throw new Error(`sync.url in runner.json ${problem}.`);
  return async (fn, args) => {
    const res = await fetch(`${base}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fn, args, format: 'json' }),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => undefined);
    if (!res.ok || body?.status !== 'success') {
      if (/could not find (public )?function/i.test(body?.errorMessage ?? '')) throw new Error('This deployment has no sync:scrubStoredBatch yet: it needs backend API 47 or later.');
      throw new Error(body?.errorMessage ?? `HTTP ${res.status}`);
    }
    return body.value;
  };
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(0);
  }
  const home = process.env.THREADBEAR_HOME ?? path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear');
  const url = JSON.parse(fs.readFileSync(path.join(home, 'runner.json'), 'utf8')).sync?.url;
  const key = fs.readFileSync(path.join(home, 'secrets', 'convex-key'), 'utf8').trim();
  if (!url || !key) {
    console.error(`No sync.url or secrets/convex-key under ${home}.`);
    process.exit(1);
  }
  const apply = args.includes('--apply');
  const table = flag(args, '--table');
  if (table && !TABLES.includes(table)) {
    console.error(`--table is one of: ${TABLES.join(', ')}`);
    process.exit(2);
  }
  console.log(`${apply ? 'Rewriting' : 'Dry run against'} ${url}`);
  const totals = await scrubStored({ post: httpPost(url), key, tables: table ? [table] : TABLES, apply, batch: Number(flag(args, '--batch') ?? 200), say: console.log });
  const all = Object.values(totals).reduce((n, t) => n + t.changed, 0);
  console.log(`\nRules v${Object.values(totals)[0]?.rulesVersion}: ${all} rows ${apply ? 'changed' : 'would change'}. Backups and exports keep old copies, and a key that leaked has to be rotated.`);
}
