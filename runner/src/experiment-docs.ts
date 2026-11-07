// docs/experiments.md, made from the experiment files (experiments.ts):
// what each does, for the guide (the website's Experiments page shows the
// list), and where each lives and how to take it out, for forks. Written
// by `npm run experiment-docs`; experiment-docs.test.ts fails when the
// file is out of date.
//
// Every entry is one line, and .gitattributes merges the file by union:
// two threads that each add an experiment both keep their line when they
// land, where a hand-kept list made them collide (7 Nov). The check
// compares the lines in any order, so a union merge that lands them out of
// order still passes; the next `npm run experiment-docs` sorts them.
import type { Experiment } from './experiments.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-06" to "6 Nov 2026". */
export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const oneLine = (text: string) => text.split(/\s+/).join(' ').trim();
const cell = (text: string) => oneLine(text).replaceAll('|', '\\|');

export const LIST_START = '<!-- list:start -->';
export const LIST_END = '<!-- list:end -->';

/** The guide's line for an experiment. */
export function guideLine(x: Experiment): string {
  return `- **${x.name}** (\`${x.id}\`, since ${longDate(x.added)}${x.on ? ', on unless you turn it off' : ''}). ${oneLine(x.does)}`;
}

export function experimentDocs(experiments: readonly Experiment[]): string {
  return [
    '# Experiments',
    '',
    '<!-- Made by `npm run experiment-docs` in runner/ from runner/src/experiments/*.md:',
    'edit those, not this. Each entry is one line, so two threads adding one at once',
    'both keep theirs (.gitattributes merges this file by union). -->',
    '',
    'New features that are still being tried out start off, with a switch under',
    '`experiments` in `runner.json` (the user guide, "Experiments", says how to turn one',
    'on). These are the ones there are now.',
    '',
    '## What each one does',
    '',
    LIST_START,
    ...experiments.map(guideLine),
    LIST_END,
    '',
    '## Where each one lives, and taking it out',
    '',
    'For forks (docs/forking.md). Each one\'s switch is `experiments.<id>` in `runner.json`, and',
    'its own file is `runner/src/experiments/<id>.md`, which goes with it.',
    '',
    '| Experiment | Lives in | Taking it out |',
    '|---|---|---|',
    ...experiments.map((x) => `| ${cell(x.name)} (\`${x.id}\`) | ${cell(x.livesIn)} | ${cell(x.takingOut)} |`),
    '',
  ].join('\n');
}

/** The file's lines in a fixed order, to compare whatever order a merge left them in. */
export function sortedLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').sort();
}
