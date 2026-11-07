import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFiles, inputLines, keptWords, pictureCount } from './tool-body.ts';

test('a command reads as typed, anything else as key and value', () => {
  assert.deepEqual(inputLines(JSON.stringify({ command: 'ls -la', description: 'List' })), ['$ ls -la']);
  assert.deepEqual(inputLines(JSON.stringify({ file_path: '/x/y.ts', limit: 3 })), ['file_path: /x/y.ts', 'limit: 3']);
});

test("input that isn't an object says nothing rather than throw", () => {
  assert.deepEqual(inputLines(undefined), []);
  assert.deepEqual(inputLines('not json'), []);
  assert.deepEqual(inputLines('[1]'), []);
});

test('diffs keep only what names a file', () => {
  assert.deepEqual(diffFiles(JSON.stringify([{ path: 'a.ts', hunks: [] }, { hunks: [] }])), [{ path: 'a.ts', hunks: [] }]);
  assert.deepEqual(diffFiles('nope'), []);
});

test('each reason a body is missing has its own words', () => {
  assert.match(keptWords('withheld'), /secrets/);
  assert.match(keptWords('expired'), /expired/);
  assert.equal(keptWords(null), 'Kept on the runner.');
});

test('a malformed body from another machine draws what it can and never throws', () => {
  assert.deepEqual(diffFiles(JSON.stringify([{ path: 'a.ts', hunks: null }, { path: 'b.ts', hunks: [null, { lines: ['x', 1] }] }])), [
    { path: 'a.ts', hunks: [] },
    { path: 'b.ts', hunks: [{ lines: ['x'] }] },
  ]);
  assert.equal(pictureCount(4294967296), 20);
  assert.equal(pictureCount('2'), 0);
  assert.equal(pictureCount(2), 2);
});
