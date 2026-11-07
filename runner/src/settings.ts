// settings.get and settings.update (docs/protocol.md): the runner's side
// of the Settings window. Everything lives in runner.json.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { expandHome, readRunnerJson, writeRunnerJson } from './config.ts';
import type { Clock } from './clock.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import type { Notification } from './runner.ts';
import type { Models } from './models/index.ts';
import type { BringInSetting } from './bring-in.ts';
import { DEFAULT_BRING_IN_DAYS, parseBringIn } from './bring-in.ts';

export type Settings = {
  defaultCwd: string;
  idleMinutes: number;
  maxLiveCLIs: number;
  followMain: boolean;
  bulletReplies: boolean;
  oneReply: boolean;
  // How often a fork's runner starts a thread to bring in Mike's releases
  // (bring-in.ts): every so many days, 'important' or 'off'.
  bringIn: BringInSetting;
  models: {
    pool: string | null;
    privateFolders: string[];
  };
};

export type SettingsUpdate = {
  defaultCwd?: string;
  idleMinutes?: number;
  maxLiveCLIs?: number;
  followMain?: boolean;
  bulletReplies?: boolean;
  oneReply?: boolean;
  bringIn?: BringInSetting;
  models?: { pool?: string | null; privateFolders?: string[] };
};

export class SettingsService {
  private cfg: Config;
  private publish: (n: Notification) => void;
  // The pools there are, so models.pool can be checked; unchecked without.
  private poolIds?: () => string[];

  constructor(opts: { config: Config; publish: (n: Notification) => void; poolIds?: () => string[] }) {
    this.cfg = opts.config;
    this.poolIds = opts.poolIds;
    this.publish = opts.publish;
  }

  get(): Settings {
    return {
      defaultCwd: this.cfg.defaults.cwd,
      idleMinutes: Math.round((this.cfg.idleMs / 60_000) * 100) / 100,
      maxLiveCLIs: this.cfg.maxLive,
      // What the next start will do, which is what the switch means.
      followMain: readRunnerJson(this.cfg.home).followMain !== false,
      bulletReplies: this.cfg.bulletReplies,
      oneReply: this.cfg.oneReply,
      bringIn: bringInSetting(this.cfg.home),
      models: {
        pool: this.cfg.models.pool,
        privateFolders: [...this.cfg.models.privateFolders],
      },
    };
  }

  // Checks everything before saving anything, so a bad field changes nothing.
  update(u: SettingsUpdate): Settings {
    let cwd: string | undefined;
    if (u.defaultCwd !== undefined) {
      cwd = u.defaultCwd.trim();
      const full = path.resolve(expandHome(cwd));
      if (!cwd || !isDirectory(full)) throw bad(`Folder not found: ${cwd || '(blank)'}`);
    }
    if (u.idleMinutes !== undefined && !(u.idleMinutes >= 1 && u.idleMinutes <= 24 * 60)) throw bad('idleMinutes must be from 1 to 1440');
    if (u.maxLiveCLIs !== undefined && !(Number.isInteger(u.maxLiveCLIs) && u.maxLiveCLIs >= 1 && u.maxLiveCLIs <= 20)) {
      throw bad('maxLiveCLIs must be a whole number from 1 to 20');
    }
    const folders = u.models?.privateFolders?.map((f) => f.trim()).filter(Boolean);
    const pool = u.models?.pool === undefined ? undefined : u.models.pool === null ? null : u.models.pool.trim();
    if (pool === '') throw bad('pool must be a pool id or null');
    const pools = pool ? this.poolIds?.() : undefined;
    if (pool && pools && !pools.includes(pool)) throw bad(`No pool called ${pool}. Pools: ${pools.join(', ') || 'none'}`);

    const json = readRunnerJson(this.cfg.home);
    if (cwd !== undefined) {
      json.defaults = { ...json.defaults, cwd };
      this.cfg.defaults.cwd = path.resolve(expandHome(cwd));
    }
    if (u.idleMinutes !== undefined) {
      json.idleMinutes = u.idleMinutes;
      this.cfg.idleMs = u.idleMinutes * 60_000;
    }
    if (u.maxLiveCLIs !== undefined) {
      json.maxLiveCLIs = u.maxLiveCLIs;
      this.cfg.maxLive = u.maxLiveCLIs;
    }
    // Saved only: the updater reads it when the runner starts.
    if (u.followMain !== undefined) json.followMain = u.followMain;
    if (u.bulletReplies !== undefined) json.bulletReplies = this.cfg.bulletReplies = u.bulletReplies;
    if (u.oneReply !== undefined) json.oneReply = this.cfg.oneReply = u.oneReply;
    // Read each time it's needed (bring-in.ts), so this takes effect at once.
    if (u.bringIn !== undefined) json.releases = { ...json.releases, bringIn: u.bringIn };
    if (folders !== undefined || pool !== undefined) {
      json.models = { ...json.models };
      if (pool !== undefined) json.models.pool = this.cfg.models.pool = pool;
      if (folders !== undefined) json.models.privateFolders = this.cfg.models.privateFolders = [...new Set(folders)];
    }
    writeRunnerJson(this.cfg.home, json);
    return this.changed();
  }

  private changed(): Settings {
    const settings = this.get();
    this.publish({ method: 'settings.updated', params: { settings } });
    return settings;
  }
}

export function settingsMethods(s: SettingsService): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'settings.get': () => ({ settings: s.get() }),
    'settings.update': (p) => {
      const u: SettingsUpdate = {};
      if (p.defaultCwd !== undefined) u.defaultCwd = str(p.defaultCwd, 'defaultCwd');
      if (p.idleMinutes !== undefined) u.idleMinutes = num(p.idleMinutes, 'idleMinutes');
      if (p.maxLiveCLIs !== undefined) u.maxLiveCLIs = num(p.maxLiveCLIs, 'maxLiveCLIs');
      if (p.followMain !== undefined) {
        if (typeof p.followMain !== 'boolean') throw bad('followMain must be a boolean');
        u.followMain = p.followMain;
      }
      if (p.bulletReplies !== undefined) {
        if (typeof p.bulletReplies !== 'boolean') throw bad('bulletReplies must be a boolean');
        u.bulletReplies = p.bulletReplies;
      }
      if (p.oneReply !== undefined) {
        if (typeof p.oneReply !== 'boolean') throw bad('oneReply must be a boolean');
        u.oneReply = p.oneReply;
      }
      if (p.bringIn !== undefined) {
        const b = parseBringIn(p.bringIn);
        if (b === undefined) throw bad("bringIn must be a whole number of days from 1 to 365, 'important' or 'off'");
        u.bringIn = b;
      }
      if (p.models !== undefined) {
        const m = p.models;
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('models must be an object');
        const mm = m as Record<string, unknown>;
        u.models = {};
        if (mm.pool !== undefined) {
          if (mm.pool !== null && typeof mm.pool !== 'string') throw bad('models.pool must be a pool id or null');
          u.models.pool = mm.pool;
        }
        if (mm.privateFolders !== undefined) {
          if (!Array.isArray(mm.privateFolders) || mm.privateFolders.some((f) => typeof f !== 'string')) {
            throw bad('models.privateFolders must be an array of strings');
          }
          u.models.privateFolders = mm.privateFolders as string[];
        }
      }
      return { settings: s.update(u) };
    },
  };
}

// models.run: one call by hand, for `tb models try`, on the pool like any other.
export function modelMethods(m: Models): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'models.run': async (p) => {
      const job = str(p.job, 'job');
      const text = str(p.text, 'text');
      const cwd = p.cwd === undefined ? undefined : str(p.cwd, 'cwd');
      const feature = 'tb';
      switch (job) {
        case 'classify': {
          if (!Array.isArray(p.labels) || p.labels.length < 2 || p.labels.some((l) => typeof l !== 'string')) throw bad('labels must be 2 or more strings');
          return m.classify({ feature, cwd, text, labels: p.labels as string[], instructions: p.system === undefined ? undefined : str(p.system, 'system') });
        }
        case 'extract': {
          const f = p.fields;
          if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.keys(f).length || Object.values(f).some((v) => typeof v !== 'string')) {
            throw bad('fields must map each name to a description');
          }
          return m.extract({ feature, cwd, text, fields: f as Record<string, string> });
        }
        case 'summarize':
          return m.summarize({ feature, cwd, text, maxWords: p.maxWords === undefined ? undefined : num(p.maxWords, 'maxWords') });
        case 'generate':
          return m.generate({ feature, cwd, prompt: text, system: p.system === undefined ? undefined : str(p.system, 'system'), ...maxTokens(p) });
        default:
          throw bad('job must be classify, extract, summarize or generate');
      }
    },
  };
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

function str(v: unknown, k: string): string {
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function num(v: unknown, k: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${k} must be a number`);
  return v;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// models.run's optional output limit, for trying a feature's own call.
function maxTokens(p: Record<string, unknown>): { maxTokens?: number } {
  if (p.maxTokens === undefined || p.maxTokens === null) return {};
  if (typeof p.maxTokens !== 'number' || !Number.isInteger(p.maxTokens) || p.maxTokens < 1 || p.maxTokens > 8000) throw bad('maxTokens must be a whole number from 1 to 8000');
  return { maxTokens: p.maxTokens };
}

// runner.json `releases.bringIn`, or every 5 days.
export function bringInSetting(home: string): BringInSetting {
  return parseBringIn(readRunnerJson(home).releases?.bringIn) ?? DEFAULT_BRING_IN_DAYS;
}
