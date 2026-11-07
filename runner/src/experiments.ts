// Experiments: new features that start off for everyone, with a switch
// in runner.json (`"experiments": { "<id>": true }`) so Mike can run one
// on his own copy first. Once he's happy with it, the experiment and its
// switch are taken out and the feature just runs (AGENTS.md, "Experiments"),
// rather than its default flipping and the switch staying.
//
// Since the repo went public (5 Nov 2026) other people run Threadbear, so
// Mike asked on 6 Nov that features he's still trying out land here
// rather than straight on. Each one names the schedule that asks him,
// a few days after it lands, whether to turn it on for everyone, so
// none is forgotten (AGENTS.md, "Experiments"; experiments.test.ts
// checks every entry has one).
//
// Each experiment is a file of its own, `src/experiments/<id>.md`: its
// fields up top, then what it does (for the guide), where it lives and
// how to take it out (for forks). docs/experiments.md is made from them
// (experiment-docs.ts). One file each, rather than one list, because
// several threads add experiments at once and every one of them used to
// edit the same lines here, in the guide and in the forking table, and
// collide when landing (7 Nov). Releases copy all of src/, so the files
// go with the code.
import fs from 'node:fs';
import path from 'node:path';
import { readRunnerJson } from './config.ts';

export type Experiment = {
  id: string;
  // A short name, for the guide's list.
  name: string;
  // What it does, in a few words, for tb status.
  title: string;
  // The day it landed (YYYY-MM-DD).
  added: string;
  // Whether it's on for anyone whose runner.json doesn't say.
  on: boolean;
  // The schedule (schedule_message's id) that asks Mike whether to flip
  // `on`, or to drop the experiment.
  reminder: string;
  // The file's sections, as written (Markdown).
  does: string;
  livesIn: string;
  takingOut: string;
};

export const EXPERIMENTS_DIR = path.join(import.meta.dirname, 'experiments');

/** One experiment file: `key: value` lines between `---`, then `## ` sections. */
export function parseExperiment(text: string, file = 'experiment'): Experiment {
  const match = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: starts with its fields between --- lines`);
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const sections: Record<string, string> = {};
  for (const chunk of match[2].split(/^## /m).slice(1)) {
    const [heading, ...body] = chunk.split('\n');
    sections[heading.trim().toLowerCase()] = body.join('\n').trim();
  }
  const need = (value: string | undefined, what: string) => {
    if (!value) throw new Error(`${file}: has no ${what}`);
    return value;
  };
  return {
    id: need(fields.id, 'id'),
    name: need(fields.name, 'name'),
    title: need(fields.title, 'title'),
    added: need(fields.added, 'added date'),
    on: fields.on === 'true',
    reminder: need(fields.reminder, 'reminder'),
    does: need(sections['what it does'], '"## What it does" section'),
    livesIn: need(sections['lives in'], '"## Lives in" section'),
    takingOut: need(sections['taking it out'], '"## Taking it out" section'),
  };
}

export function readExperiments(dir = EXPERIMENTS_DIR): Experiment[] {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  return files.map((f) => parseExperiment(fs.readFileSync(path.join(dir, f), 'utf8'), f))
    .sort((a, b) => a.added.localeCompare(b.added) || a.id.localeCompare(b.id));
}

export const EXPERIMENTS: readonly Experiment[] = readExperiments();

// A string, checked by experiments.test.ts against the files, rather than
// a union of every id: that one line was a collision too.
export type ExperimentId = string;

// Read from runner.json each time, so turning one on or off takes effect
// at the next turn, with no restart.
export function experimentOn(home: string, id: ExperimentId): boolean {
  const said = readRunnerJson(home).experiments?.[id];
  if (typeof said === 'boolean') return said;
  return EXPERIMENTS.find((x) => x.id === id)?.on ?? false;
}

// The ids of every experiment that's on for this runner, for hello's
// `experiments`: the Mac app reads it for experiments that live in the
// app (Voice mode), so one switch in runner.json still turns them on.
export function experimentsOn(home: string): string[] {
  return EXPERIMENTS.filter((x) => experimentOn(home, x.id)).map((x) => x.id);
}
