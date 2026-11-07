// docs/experiments.md is made from src/experiments/*.md (experiment-docs.ts):
// this fails when it's out of date. `npm run experiment-docs` writes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXPERIMENTS } from '../../src/experiments.ts';
import { experimentDocs, guideLine, longDate, sortedLines } from '../../src/experiment-docs.ts';

const FILE = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'experiments.md');

test('docs/experiments.md matches the experiment files', () => {
  const made = experimentDocs(EXPERIMENTS);
  if (process.env.UPDATE_EXPERIMENT_DOCS === '1') {
    fs.writeFileSync(FILE, made);
    return;
  }
  const written = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  // In any order: a union merge of two threads' new lines may leave them unsorted.
  assert.deepEqual(sortedLines(written), sortedLines(made), 'docs/experiments.md is out of date: run `npm run experiment-docs` in runner/ and commit it');
});

test('experiment docs: one line per experiment, with its id and the day it landed', () => {
  const x = { id: 'demo', name: 'A demo', title: 'A demo: does a thing', added: '2026-11-07', on: false, reminder: '12345678',
    does: 'Does a\nthing | well.', livesIn: '`a.ts`', takingOut: 'Delete it.' };
  assert.equal(longDate('2026-11-07'), '7 Nov 2026');
  assert.equal(guideLine(x), '- **A demo** (`demo`, since 7 Nov 2026). Does a thing | well.');
  const docs = experimentDocs([x]);
  assert.ok(docs.includes('| A demo (`demo`) | `a.ts` | Delete it. |'));
  assert.equal(docs.split('\n').filter((l) => l.includes('demo')).length, 2);
});
