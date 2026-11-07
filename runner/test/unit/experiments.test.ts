// Experiments (src/experiments.ts): each new feature still being tried
// out is off by default, with a switch in runner.json, and names the
// schedule that asks Mike whether to turn it on for everyone (AGENTS.md,
// "Experiments"), so none is left half-on and forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXPERIMENTS, EXPERIMENTS_DIR, experimentOn, experimentsOn, parseExperiment } from '../../src/experiments.ts';
import { tmpDir } from '../helpers/fakes.ts';

test('experiments: each has a unique id, a landing date, a title and the schedule that asks about it', () => {
  const ids = new Set<string>();
  for (const x of EXPERIMENTS) {
    assert.ok(/^[a-z][a-zA-Z0-9]*$/.test(x.id), `${x.id}: an id in camelCase`);
    assert.ok(!ids.has(x.id), `${x.id}: listed twice`);
    ids.add(x.id);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(x.added) && !Number.isNaN(Date.parse(x.added)), `${x.id}: added is a YYYY-MM-DD date`);
    assert.ok(x.title.trim().length > 10, `${x.id}: says what it does`);
    // schedule_message's id: book the check-in with it when the
    // experiment lands, and put the id here.
    assert.ok(/^[0-9a-f]{8}$/.test(x.reminder), `${x.id}: reminder is the id of the schedule that asks the user whether to turn it on for everyone`);
  }
});

test("experiments: runner.json's switch wins over the default, read afresh each time", () => {
  const home = tmpDir();
  assert.equal(experimentOn(home, 'labReview'), false);
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { labReview: true } }));
  assert.equal(experimentOn(home, 'labReview'), true);
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { labReview: 'yes' } }));
  assert.equal(experimentOn(home, 'labReview'), false, 'only a true or false counts');
});

test("experiments: hello's list is the ones on, for experiments that live in the app", () => {
  const home = tmpDir();
  assert.deepEqual(experimentsOn(home), EXPERIMENTS.filter((x) => x.on).map((x) => x.id));
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { voiceMode: true, labReview: false, notOne: true } }));
  const on = experimentsOn(home);
  assert.ok(on.includes('voiceMode'), 'Voice mode, which the Mac app checks');
  assert.ok(!on.includes('labReview'));
  assert.ok(!on.includes('notOne'), 'only experiments that have a file');
});

test('experiments: every experimentOn in the runner names an experiment that has a file', () => {
  const ids = new Set(EXPERIMENTS.map((x) => x.id));
  const src = path.join(import.meta.dirname, '..', '..', 'src');
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.name.endsWith('.ts')) {
        for (const m of fs.readFileSync(at, 'utf8').matchAll(/experimentOn\([^,()]+,\s*'(\w+)'\)/g)) used.add(m[1]);
      }
    }
  };
  walk(src);
  assert.ok(used.size >= 3, 'found the calls');
  for (const id of used) assert.ok(ids.has(id), `experimentOn(..., '${id}') has no src/experiments/${id}.md`);
});

test("experiments: a file's name is its id", () => {
  for (const f of fs.readdirSync(EXPERIMENTS_DIR).filter((f) => f.endsWith('.md'))) {
    assert.equal(parseExperiment(fs.readFileSync(path.join(EXPERIMENTS_DIR, f), 'utf8'), f).id, f.slice(0, -3));
  }
});

test('experiments: a file missing a section says which', () => {
  assert.throws(() => parseExperiment('---\nid: x\nname: X\ntitle: Does a thing\nadded: 2026-11-07\non: false\nreminder: 12345678\n---\n\n## What it does\n\nA thing.\n', 'x.md'), /x\.md: has no "## Lives in"/);
});
