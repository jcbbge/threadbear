import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capLog, tidy } from '../../src/housekeeping.ts';
import { ensureHome, paths } from '../../src/config.ts';
import { tmpDir } from '../helpers/fakes.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-12-01T00:00:00.000Z');

function age(file: string, days: number): void {
  const t = new Date(NOW - days * DAY);
  fs.utimesSync(file, t, t);
}

function thread(home: string, id: string, archivedAt?: string): string {
  const dir = paths.thread(home, id);
  fs.mkdirSync(paths.media(home, id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'thread.json'), JSON.stringify({ id, ...(archivedAt ? { archivedAt } : {}) }));
  fs.writeFileSync(path.join(paths.media(home, id), 'shot.png'), 'png');
  fs.writeFileSync(path.join(dir, 'events.ndjson'), '{"seq":1}\n');
  return dir;
}

test('a log over the cap is kept once as .1 and emptied in place', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'runner.log');
  fs.writeFileSync(file, 'x'.repeat(300));
  // Another writer holds it open for appending, like launchd's stderr does.
  const fd = fs.openSync(file, 'a');
  assert.equal(capLog(file, 100, { inPlace: true }), true);
  fs.writeSync(fd, 'after\n');
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(300));
  // O_APPEND writers carry on at the new end, with no gap of NULs.
  assert.equal(fs.readFileSync(file, 'utf8'), 'after\n');
  assert.equal(capLog(file, 100, { inPlace: true }), false);
});

test('a log written by opening it each time is renamed instead', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'update.log');
  fs.writeFileSync(file, 'y'.repeat(300));
  fs.writeFileSync(`${file}.1`, 'older');
  assert.equal(capLog(file, 100), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'y'.repeat(300));
  assert.equal(capLog(path.join(dir, 'missing.log'), 100), false);
});

test('tidy clears old pasted images, old trash and, with archivedMediaDays, long-archived threads\' pictures', () => {
  const home = tmpDir();
  ensureHome(home);
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ archivedMediaDays: 30 }));
  const oldPaste = path.join(paths.inbox(home), 'old.png');
  const newPaste = path.join(paths.inbox(home), 'new.png');
  fs.writeFileSync(oldPaste, 'a');
  fs.writeFileSync(newPaste, 'b');
  age(oldPaste, 8);
  age(newPaste, 1);

  const bin = path.join(home, 'trash');
  fs.mkdirSync(path.join(bin, 'gone-1'), { recursive: true });
  fs.mkdirSync(path.join(bin, 'recent-2'), { recursive: true });
  age(path.join(bin, 'gone-1'), 31);
  age(path.join(bin, 'recent-2'), 3);

  const longAgo = thread(home, 'archived-long-ago', new Date(NOW - 40 * DAY).toISOString());
  const lately = thread(home, 'archived-lately', new Date(NOW - 5 * DAY).toISOString());
  const open = thread(home, 'open');

  const done = tidy({ home, logs: [], now: NOW });

  assert.equal(fs.existsSync(oldPaste), false);
  assert.equal(fs.existsSync(newPaste), true);
  assert.equal(fs.existsSync(path.join(bin, 'gone-1')), false);
  assert.equal(fs.existsSync(path.join(bin, 'recent-2')), true);
  // The thread itself stays; only its pictures go, and the folder is back
  // empty so a thread taken out of the archive can save new ones.
  assert.deepEqual(fs.readdirSync(path.join(longAgo, 'media')), []);
  assert.equal(fs.existsSync(path.join(longAgo, 'events.ndjson')), true);
  assert.deepEqual(fs.readdirSync(path.join(lately, 'media')), ['shot.png']);
  assert.deepEqual(fs.readdirSync(path.join(open, 'media')), ['shot.png']);
  assert.deepEqual(done, { logs: 0, inbox: 1, trash: 1, media: 1 });
});

test("without archivedMediaDays, archived threads' pictures are kept however old", () => {
  const home = tmpDir();
  ensureHome(home);
  const longAgo = thread(home, 'archived-long-ago', new Date(NOW - 400 * DAY).toISOString());
  const done = tidy({ home, logs: [], now: NOW });
  assert.deepEqual(fs.readdirSync(path.join(longAgo, 'media')), ['shot.png']);
  assert.equal(done.media, 0);
  // Nor with something that isn't a number of days.
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ archivedMediaDays: '30' }));
  assert.equal(tidy({ home, logs: [], now: NOW }).media, 0);
});
