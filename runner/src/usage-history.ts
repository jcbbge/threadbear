// Each login's 5-hour and weekly windows over time, for the Usage panel's
// charts and how fast a window is going down (docs/protocol.md, "Usage
// history"). UsageStore hands over whatever it would show every time it
// looks again (a new limits.json, a live reading, a reset); a sample is
// kept when the window moved by half a point or more, or 30 minutes after
// the last one, so a flat line still has points. Kept in
// <data dir>/usage-history.json for 8 days.
import path from 'node:path';
import type { AccountUsage } from './protocol.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';

export const HISTORY_KINDS = ['five_hour', 'weekly'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number] | 'weekly_model';
// A model's own week ("Weekly Fable") is kept too, so the Usage panel can
// chart it like the main week. There can be several (Opus, Sonnet, Fable),
// so each is kept under "weekly_model:<title>" and goes out with its title.
const MODEL_PREFIX = 'weekly_model:';
type Key = string;
function keyOf(w: { kind: string; title: string }): Key | undefined {
  if ((HISTORY_KINDS as readonly string[]).includes(w.kind)) return w.kind;
  return w.kind === 'weekly_model' ? MODEL_PREFIX + w.title : undefined;
}
function kindOf(key: Key): { kind: HistoryKind; title?: string } {
  return key.startsWith(MODEL_PREFIX) ? { kind: 'weekly_model', title: key.slice(MODEL_PREFIX.length) } : { kind: key as HistoryKind };
}
export type HistoryRow = { accountId: string; kind: HistoryKind; title?: string; samples: Sample[] };
export type Sample = [number, number]; // [atMs, remainingPercent]

export const HISTORY_DAYS = 8;
export const MIN_MOVE = 0.5;
export const MAX_GAP_MS = 30 * 60_000;
// Samples come in bursts (every reading of a busy thread); the file is
// written once they settle.
const SAVE_DELAY_MS = 5_000;

type HistoryFile = { version: 1; accounts: Record<string, Record<Key, Sample[]>> };

export class UsageHistory {
  private file: string;
  private clock: Clock;
  private log: Logger;
  private samples = new Map<string, Map<Key, Sample[]>>();
  private saveTimer?: TimerHandle;
  private writes = true;

  constructor(o: { dataDir: string; clock: Clock; log: Logger }) {
    this.file = path.join(o.dataDir, 'usage-history.json');
    this.clock = o.clock;
    this.log = o.log;
    const saved = readJsonSync<HistoryFile>(this.file);
    if (saved?.version === 1 && saved.accounts && typeof saved.accounts === 'object') {
      for (const [id, kinds] of Object.entries(saved.accounts)) {
        const m = new Map<Key, Sample[]>();
        for (const [key, list] of Object.entries(kinds ?? {})) {
          if (!(HISTORY_KINDS as readonly string[]).includes(key) && !key.startsWith(MODEL_PREFIX)) continue;
          if (Array.isArray(list)) m.set(key, list.filter((s) => Array.isArray(s) && typeof s[0] === 'number' && typeof s[1] === 'number'));
        }
        this.samples.set(id, m);
      }
    }
  }

  // What the store would show for this account right now.
  observe(accountId: string, usage: AccountUsage | undefined): void {
    if (!usage) return;
    const now = this.clock.now();
    let changed = false;
    const seen = new Set<Key>();
    for (const w of usage.windows) {
      const kind = keyOf(w);
      if (!kind || seen.has(kind)) continue;
      seen.add(kind);
      let m = this.samples.get(accountId);
      if (!m) this.samples.set(accountId, (m = new Map()));
      let list = m.get(kind);
      if (!list) m.set(kind, (list = []));
      const last = list[list.length - 1];
      const pct = Math.round(w.remainingPercent * 10) / 10;
      // A jump up is a reset, which a move of half a point covers.
      if (last && Math.abs(pct - last[1]) < MIN_MOVE && now - last[0] < MAX_GAP_MS) continue;
      if (last && now < last[0]) continue; // the clock went back
      list.push([now, pct]);
      changed = true;
    }
    if (changed) {
      this.prune(now);
      this.scheduleSave();
    }
  }

  // Samples since `since`, per account and window.
  rows(since: number): HistoryRow[] {
    const out: HistoryRow[] = [];
    // The main two first, then the models' weeks by title.
    const order = (k: Key) => { const i = (HISTORY_KINDS as readonly string[]).indexOf(k); return i < 0 ? HISTORY_KINDS.length : i; };
    for (const [accountId, m] of this.samples) {
      const keys = [...m.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
      for (const key of keys) {
        const list = m.get(key)?.filter((s) => s[0] >= since);
        if (list?.length) out.push({ accountId, ...kindOf(key), samples: list });
      }
    }
    return out;
  }

  // A draining runner (Handovers) leaves the file to the new one.
  stopWriting(): void {
    this.writes = false;
    this.saveTimer?.cancel();
    this.saveTimer = undefined;
  }

  // Writes now if a save is waiting (at shutdown).
  flush(): void {
    if (!this.saveTimer) return;
    this.saveTimer.cancel();
    this.saveTimer = undefined;
    this.save();
  }

  private prune(now: number): void {
    const from = now - HISTORY_DAYS * 24 * 3_600_000;
    for (const m of this.samples.values()) {
      for (const [kind, list] of m) {
        const keep = list.findIndex((s) => s[0] >= from);
        if (keep > 0) m.set(kind, list.slice(keep));
        else if (keep < 0) m.delete(kind);
      }
    }
  }

  private scheduleSave(): void {
    if (!this.writes || this.saveTimer) return;
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    if (!this.writes) return;
    const doc: HistoryFile = {
      version: 1,
      accounts: Object.fromEntries([...this.samples].map(([id, m]) => [id, Object.fromEntries(m)])),
    };
    try {
      atomicWriteFileSync(this.file, JSON.stringify(doc) + '\n');
    } catch (err) {
      this.log.warn('usage: could not write usage-history.json', { error: String(err) });
    }
  }
}
