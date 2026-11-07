// The push relay's install versions (relay/convex/versions.ts). From
// Gautam's 6 Nov 2026 scan of relay/ (F2): an install's self-reported
// version went into relay:stats as a plain object's key, so one install
// registering as "$x", "é" or "toString" broke the stats query for good:
// Convex refuses a field name starting with "$" or holding non-ASCII, and
// "toString" + 1 is a string the return validator turns down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convexToJson } from 'convex/values';
import { countVersions, storedVersion, UNKNOWN } from '../../../relay/convex/versions.ts';

const HOSTILE = ['$x', 'é', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', '_id', ' api-52', 'api 52', 'a'.repeat(41), '', 'api-52\n', '\u0000'];

// What relay:stats returns must be a Convex value whose versions are all numbers.
function checkStats(versions: Record<string, number>): void {
  assert.doesNotThrow(() => convexToJson({ versions } as any));
  for (const [k, n] of Object.entries(versions)) {
    assert.equal(typeof n, 'number', `${JSON.stringify(k)} counts as a number`);
    assert.ok(!k.startsWith('$') && !k.startsWith('_') && /^[\x20-\x7e]+$/.test(k), `${JSON.stringify(k)} is a plain field name`);
  }
}

test('F2: what an install says its version is gets stored only if it is a plain version word', () => {
  assert.equal(storedVersion('api-52'), 'api-52');
  assert.equal(storedVersion('0.1.0'), '0.1.0');
  for (const bad of ['$x', 'é', '__proto__', '_id', ' api-52', 'api 52', 'a'.repeat(41), '', 'api-52\n', 42, null, {}]) assert.equal(storedVersion(bad), UNKNOWN, JSON.stringify(bad));
});

test('F2: stats count every version, hostile ones stored before the rule included, without breaking', () => {
  const counts = countVersions(['api-52', 'api-52', undefined, 'toString', 'constructor', ...HOSTILE]);
  checkStats(counts);
  assert.equal(counts['api-52'], 2);
  assert.equal(counts.toString, 2, '"toString" counted as itself, from 0');
  assert.equal(counts.constructor, 2);
  assert.equal(counts.unknown, 1);
  // Everything that isn't a plain word, as stored before: "$x", "é", "__proto__" and the rest.
  assert.equal(counts.other, HOSTILE.filter((h) => storedVersion(h) === UNKNOWN).length);
  assert.equal(Object.getPrototypeOf(counts), Object.prototype, 'no prototype key slipped in as a field');
});

test('F2: what is stored now always counts under its own name', () => {
  const counts = countVersions(HOSTILE.map(storedVersion));
  checkStats(counts);
  assert.equal(counts.other, undefined);
});
