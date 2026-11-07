// Text cut short before it goes to Convex is cut where no secret is split in
// two (src/safe-cut.ts), and the wake note is scrubbed whole before it's cut.
// Daybreak, 6 Nov 2026 ("Wake-note truncation can bypass secret redaction"): a
// 179-character waitFor condition put a connection URL's "@" just past the
// note's 160-character cut, and neither scrub pass knew the password any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { wakeNote, WAKE_NOTE_MAX } from '../../src/wake-note.ts';
import { toThreadDoc, toMessageDoc, WokeRows, type MessageDoc } from '../../src/sync.ts';
import { redactSecrets, scrubDoc, scrubText } from '../../src/redaction.ts';
import { Scrubber } from '../../src/scrub.ts';
import { cutSafely, safeEnd, tailSafely, useScrubForCuts } from '../../src/safe-cut.ts';
import { BodyCollector, prepareBody } from '../../src/full-sync.ts';
import { cleanTitle, oneLine, titleFrom } from '../../src/runner.ts';
import { waitForFromTool, needsFromTool, bylineFromTool } from '../../src/needs.ts';
import { runCheck } from '../../src/schedule-check.ts';
import { runCommand } from '../../src/patches.ts';
import type { ThreadSummary } from '../../src/protocol.ts';

const PASSWORD = 'Sup3rSecretPassw0rd';
const URL = `postgres://alice:${PASSWORD}@db.internal.example/app`;

// No run of 6 or more of the secret's characters left after the scrub.
function leaks(text: string, secret = PASSWORD): boolean {
  for (let i = 0; i + 6 <= secret.length; i++) if (text.includes(secret.slice(i, i + 6))) return true;
  return false;
}

const asleep = (until: string): Pick<ThreadSummary, 'waitingOn' | 'snoozedUntil'> => ({
  snoozedUntil: '2026-11-07T09:00:00.000Z',
  waitingOn: [{ threadId: 'a', title: 'A', until }],
});

// As ConvexSync sends a row: the scrubber's safeText into toThreadDoc, then
// scrubDoc on the way up, then the backend's own pass (the same rules).
function sentWakeNote(t: Pick<ThreadSummary, 'waitingOn' | 'snoozedUntil'>, scrubber = new Scrubber({ env: {}, folders: false })): string | undefined {
  const base = { id: 't', title: 'T', cwd: '/w', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, lastSeq: 0, lastSeenSeq: 0, preview: '', createdAt: 'c', lastActivityAt: '2026-11-07T00:00:00.000Z' } as unknown as ThreadSummary;
  const doc = toThreadDoc({ ...base, ...t } as ThreadSummary, 'r', Date.parse('2026-11-07T00:00:00.000Z'), undefined, undefined, undefined, scrubber.safeText);
  return scrubDoc(scrubber.doc(doc)).wakeNote;
}

test("the wake note is scrubbed whole before it's cut, wherever the cut falls in a connection URL", () => {
  // `"A" ` is 4 characters, so a pad of n puts the URL at n + 4.
  for (let at = WAKE_NOTE_MAX - URL.length - 4; at <= WAKE_NOTE_MAX + 4; at++) {
    const pad = Math.max(0, at - 4);
    const until = `${'x'.repeat(pad)} ${URL}`.slice(0, 200);
    const note = sentWakeNote(asleep(until));
    assert.ok(note, `a note at ${at}`);
    assert.ok(note.length <= WAKE_NOTE_MAX, 'still the length a row has');
    assert.ok(!leaks(note), `no password at ${at}: ${note.slice(-40)}`);
  }
  // Daybreak's own shape: the "@" at offset 159 of the note.
  const daybreak = `${'x'.repeat(159 - 4 - URL.indexOf('@') - 1)} ${URL}`;
  assert.equal(`"A" ${daybreak}`.indexOf('@'), 159);
  assert.ok(!leaks(sentWakeNote(asleep(daybreak))!));
});

test('the wake note: a password the runner knows is masked too, and the note the agent tools show never cuts one in two', () => {
  const scrubber = new Scrubber({ env: {}, folders: false });
  scrubber.known.add(PASSWORD);
  const daybreak = `${'x'.repeat(159 - 4 - URL.indexOf('@') - 1)} ${URL}`;
  assert.ok(!leaks(sentWakeNote(asleep(daybreak), scrubber)!));
  // On the Mac (no scrubber): cut before the URL, not through it.
  for (let pad = 100; pad < 160; pad++) {
    const local = wakeNote(asleep(`${'x'.repeat(pad)} ${URL}`))!;
    assert.ok(!leaks(scrubText(local)), `a whole URL or none of it at ${pad}: ${local.slice(-40)}`);
  }
});

// The other places text is cut before it goes up, each through its own code.
const SECRETS: { name: string; text: string; secret: string }[] = [
  { name: 'a connection URL', text: `connect with ${URL} then run the migration`, secret: PASSWORD },
  { name: 'a JSON password', text: `the config is {"password": "hunter2hunter2hunter2"} so log in`, secret: 'hunter2hunter2hunter2' },
  { name: 'an assignment', text: `set AGENT_ARCHIVE_ENROLLMENT_SECRET=Ab3dEf9hIjK1mN0pQr5t and restart`, secret: 'Ab3dEf9hIjK1mN0pQr5t' },
  { name: 'Basic auth', text: `send Authorization: Basic ${Buffer.from('mike:verysecretpassword').toString('base64')} along`, secret: Buffer.from('mike:verysecretpassword').toString('base64') },
];

for (const s of SECRETS) {
  test(`${s.name}: no cut leaves part of it, alone or inside other text`, () => {
    const at = s.text.indexOf(s.secret);
    for (let max = 4; max <= s.text.length + 1; max++) {
      for (const cut of [cutSafely(s.text, max, '…'), oneLine(s.text, max), s.text.slice(0, safeEnd(s.text, max))]) {
        assert.ok(cut.length <= max, `${max}: within the length`);
        // Alone, at the end of a row, and in the middle of one (the wake note's "title" until).
        for (const sent of [cut, `"${cut}" finishes; "B" lands`]) assert.ok(!leaks(scrubText(sent), s.secret), `${max} (${at}): ${sent}`);
      }
      const tail = tailSafely(s.text, max, '…');
      assert.ok(tail.length <= max);
      assert.ok(!leaks(scrubText(`before ${tail}`), s.secret), `tail ${max}: ${tail}`);
    }
  });
}

test('what the runner cuts itself: titles, previews, waitFor conditions, asks, bylines and woken-by lines', () => {
  for (let pad = 0; pad < 220; pad += 7) {
    const text = `${'word '.repeat(pad / 5)}${URL} and more`;
    for (const cut of [titleFrom(text), oneLine(text, 140), waitForFromTool({ needs: 'nothing', waitFor: [{ thread: 'a', until: text }] })![0]!.until!, bylineFromTool({ byline: text })!]) {
      assert.ok(!leaks(scrubText(`"${cut}" finishes`)), `${pad}: ${cut}`);
    }
    const asks = needsFromTool({ needs: "you", asks: [{ action: text.repeat(4), why: text.repeat(4) }] })?.asks;
    for (const a of asks ?? []) for (const v of [a.action, a.why ?? '']) assert.ok(!leaks(scrubText(v)), `${pad}: ${v}`);
    const rows = new WokeRows();
    rows.see({ type: 'turn.started', turnId: 'u', seq: 1, ts: 'x', wokeBy: [{ kind: 'shell', description: `${'y'.repeat(pad)} ${URL}` }] } as never);
    const m = rows.take({ threadId: 't', seq: 2, role: 'assistant', text: 'hi', at: 'x' } as MessageDoc, { turnId: 'u' } as never);
    assert.ok(!leaks(scrubText(m.wokeBy![0]!.description)), `woken by, ${pad}`);
  }
  // A message is scrubbed whole before it's cut already; still so.
  const long = `${'z'.repeat(7990)} ${URL}`;
  assert.ok(!leaks(toMessageDoc('t', { type: 'assistant.text', seq: 1, ts: 'x', text: long } as never, scrubText)!.text));
});

test("a schedule check's output keeps its last part from where no secret is cut", async () => {
  const dir = tmpDir('tb-safe-cut-check-');
  // Starts with the URL, and only the last 8000 characters are kept: for these
  // lengths of padding what is kept begins inside the password.
  for (const pad of [7966, 7970, 7975, 7980, 7985, 8000]) {
    const file = path.join(dir, `out-${pad}.txt`);
    fs.writeFileSync(file, `${URL}${'q'.repeat(pad)}`);
    const r = await runCheck({ command: `cat ${JSON.stringify(file)}`, cwd: dir, home: dir, scheduleId: `s${pad}`, timeoutMs: 10_000 });
    assert.ok(!leaks(scrubText(r.output)), `${pad}: ${r.output.slice(0, 60)}`);
  }
});

test('a title that starts with a key too long to fit still has something to show, without the key', () => {
  const long = `postgres://alice:${'Pw9'.repeat(25)}@db.internal.example/app is what the app should use`;
  const title = titleFrom(long);
  assert.ok(title.length > 0 && title.length <= 60, title);
  assert.ok(!title.includes('Pw9Pw9'), title);
  // One that fits whole stays whole on the Mac, and the scrub on the way up takes all of it.
  const key = `ghp_${'A1b2'.repeat(10)} was in the log, rotate it`;
  assert.ok(titleFrom(key).includes(`ghp_${'A1b2'.repeat(10)}`));
  assert.ok(!leaks(scrubText(titleFrom(key)), 'A1b2A1b2A1b2'));
  // Plain text cuts exactly where it did.
  assert.equal(oneLine('a plain line with nothing secret in it whatsoever', 20), 'a plain line with n…');
});

// From the cross-lab review of this fix (Codex, 7 Nov 2026).
test('review: a second cut back to a word, or to a sentence, is placed in the whole text too', () => {
  const action = `${'x'.repeat(400)} password="hunter2hunter2 hunter3hunter3"${'z'.repeat(100)}`;
  const asks = needsFromTool({ needs: 'you', asks: [{ action, why: action }] })!.asks!;
  for (const v of [asks[0]!.action, asks[0]!.why!]) assert.ok(!leaks(scrubText(v), 'hunter2hunter2'), v.slice(-60));
  // A done card's next step is the first sentence of each item.
  const next = needsFromTool({ needs: 'nothing', next: [`Use password="hunter2hunter2. hunter3hunter3" to log in.`] })?.next ?? [];
  for (const n of next) assert.ok(!leaks(scrubText(n), 'hunter2hunter2'), n);
});

test('review: a secret longer than a few KB is seen whole, not past the edge of what is looked at', () => {
  const long = `postgres://alice:${'p9'.repeat(3000)}@db is the database`;
  const title = titleFrom(long);
  assert.ok(!title.includes('p9p9p9'), title.slice(0, 60));
  assert.ok(!scrubText(oneLine(long, 140)).includes('p9p9p9'));
});

test("review: a key in two lines the runner knows isn't sent as its first line", () => {
  const scrubber = new Scrubber({ env: {}, folders: false });
  const value = 'aB7xD3q9\nrT8vK6z2';
  scrubber.known.add(value);
  useScrubForCuts((t) => redactSecrets(scrubber.known.mask(t)).text);
  try {
    const title = titleFrom(`${value}\nand some words`);
    assert.ok(!title.includes('aB7xD3q9'), title);
    assert.ok(title.length > 0);
  } finally {
    useScrubForCuts(scrubText);
  }
});

test('review: full sync holds reasoning back cut where no secret is split', () => {
  const c = new BodyCollector();
  const text = `sk-${'A'.repeat(65500)} password="hunter2hunter3hunter4hunter5" and on`;
  c.see('t', { type: 'reasoning', seq: 1, ts: 'x', text } as never);
  const out = c.see('t', { type: 'assistant.text', seq: 2, ts: 'x', text: 'ok' } as never);
  const body = prepareBody(out[0]!, scrubText);
  assert.ok(!JSON.stringify(body).includes('hunter2hunter3'));
});

test('review round 2: a password longer than what a cut looks at either side is still seen whole', () => {
  for (const n of [20_000, 40_000]) {
    const long = `postgres://alice:${'p9'.repeat(n)}@db is the database`;
    assert.ok(!titleFrom(long).includes('p9p9p9'));
    // The other way: the cut deep inside the password, its scheme far behind.
    for (const at of [33_000, 60_000]) assert.ok(!scrubText(long.slice(0, safeEnd(long, at))).includes('p9p9p9'), `${n} ${at}`);
    const tail = tailSafely(long, 30_000, '…');
    assert.ok(!scrubText(tail).includes('p9p9p9'));
  }
  // A huge run that's no secret (a minified file) is still cut where it was.
  const minified = 'a=1;b=2;'.repeat(20_000);
  assert.equal(safeEnd(minified, 64_000), 64_000);
});

test('review round 2: taking punctuation off the end is checked too, and a model title cut through a secret is no title', () => {
  const scrubber = new Scrubber({ env: {}, folders: false });
  scrubber.known.add('aB7xD3q9.');
  scrubber.known.add('aB7xD3q9\nrT8vK6z2');
  useScrubForCuts((t) => redactSecrets(scrubber.known.mask(t)).text);
  try {
    const ask = needsFromTool({ needs: 'you', asks: [{ action: `${'x'.repeat(480)} aB7xD3q9. ${'z'.repeat(100)}` }] })!.asks![0]!.action;
    assert.ok(!/aB7xD3q9(?!\.)/.test(ask), ask.slice(-30));
    const next = needsFromTool({ needs: 'nothing', next: ['Use aB7xD3q9. Continue later.'] })?.next ?? [];
    for (const n of next) assert.ok(!/aB7xD3q9(?!\.)/.test(n), n);
    assert.equal(cleanTitle('aB7xD3q9\nrT8vK6z2'), '');
    assert.equal(cleanTitle('Title: Fix the sync'), 'Fix the sync');
  } finally {
    useScrubForCuts(scrubText);
  }
});

test('review round 3: output read only up to a limit drops the run it stopped in, and a tail its first', async () => {
  const dir = tmpDir('tb-safe-cut-cmd-');
  const file = path.join(dir, 'long.txt');
  fs.writeFileSync(file, `start postgres://alice:${'p9'.repeat(60_000)}@db\n`);
  const r = await runCommand(`cat ${JSON.stringify(file)}`, { cwd: dir, env: { ...process.env }, shell: ['/bin/sh', '-c'] });
  assert.equal(r.truncated, true);
  assert.ok(!scrubText(r.text).includes('p9p9p9'), r.text.slice(0, 40));
  // A schedule check whose output's start is cut inside a long password.
  fs.writeFileSync(file, `postgres://alice:${'p9'.repeat(10_000)}@db`);
  const c = await runCheck({ command: `cat ${JSON.stringify(file)}`, cwd: dir, home: dir, scheduleId: 'long', timeoutMs: 10_000 });
  assert.ok(!scrubText(c.output).includes('p9p9p9'), c.output.slice(0, 40));
});

test("review round 4: a check's output whose start was cut in a long password loses all of that run, whatever the chunks", async () => {
  const dir = tmpDir('tb-safe-cut-chunks-');
  fs.writeFileSync(path.join(dir, 'a'), `postgres://alice:${'p9'.repeat(9000)}`);
  fs.writeFileSync(path.join(dir, 'b'), `${'p9'.repeat(50)}@db\nlast line`);
  const c = await runCheck({ command: 'cat a; sleep 0.3; cat b', cwd: dir, home: dir, scheduleId: 'chunks', timeoutMs: 10_000 });
  assert.ok(!c.output.includes('p9p9p9'), c.output.slice(0, 60));
  assert.match(c.output, /last line/);
});
