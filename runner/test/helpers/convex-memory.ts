// The backend's functions (convex/*.ts) run against an in-memory database,
// so a test can call a mutation's handler the way a runner or phone would
// and look at what it left. Each module is loaded from its source with the
// types stripped and its imports bound to fakes (convex/values, the
// generated server) or to other modules loaded the same way. Indexes come
// from convex/schema.ts, so an index read is ordered as Convex orders it.
// Enough of the API for sync.ts, phone.ts, share.ts and lib.ts; not a
// Convex emulator.
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const CONVEX = path.join(import.meta.dirname, '../../../convex');

export class ConvexError extends Error {
  data: unknown;
  constructor(data: unknown) {
    super(typeof data === 'string' ? data : JSON.stringify(data));
    this.data = data;
  }
}

// Validators are only ever read for `.fields` (v.object's), at load time.
const v: Record<string, (...a: unknown[]) => unknown> = new Proxy({}, { get: (_, p) => (p === 'object' ? (fields: unknown) => ({ fields }) : () => ({})) });
const fnRef = (prefix: string[]): unknown => new Proxy(() => prefix.join('.'), { get: (_, p) => (p === Symbol.toPrimitive ? () => prefix.join('.') : fnRef([...prefix, String(p)])) });

// defineTable keeps each table's indexes, for withIndex's order.
type Def = { __idx: Record<string, string[]>; index: (n: string, f: string[]) => Def; searchIndex: () => Def };
const defineTable = (): Def => {
  const def: Def = { __idx: {}, index: (n, f) => ((def.__idx[n] = f), def), searchIndex: () => def };
  return def;
};
let indexes: Record<string, Record<string, string[]>> = {};

const fakes: Record<string, Record<string, unknown>> = {
  'convex/values': { v, ConvexError },
  'convex/server': { defineSchema: (t: Record<string, Def>) => t, defineTable },
  './_generated/server': { mutation: (x: unknown) => x, query: (x: unknown) => x, internalMutation: (x: unknown) => x, internalQuery: (x: unknown) => x, action: (x: unknown) => x, internalAction: (x: unknown) => x },
  './_generated/api': { internal: fnRef(['internal']), api: fnRef(['api']) },
};

const loaded = new Map<string, Record<string, unknown>>();

export function load(name: string): Record<string, any> {
  const hit = loaded.get(name);
  if (hit) return hit;
  const raw = fs.readFileSync(path.join(CONVEX, `${name}.ts`), 'utf8');
  const bound: Record<string, unknown> = {};
  for (const m of raw.matchAll(/^import (type )?\{([^}]*)\} from '([^']+)';$/gm)) {
    if (m[1]) continue;
    const from = m[3]!;
    const mod = fakes[from] ?? (from.startsWith('./') ? load(from.slice(2)) : undefined);
    if (!mod) throw new Error(`convex-memory: no fake for ${from} (in ${name}.ts)`);
    for (const spec of m[2]!.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (spec.startsWith('type ')) continue;
      const [orig, as] = spec.split(/\s+as\s+/);
      bound[(as ?? orig)!.trim()] = mod[orig!.trim()];
    }
  }
  const names = [...raw.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]!);
  let src = raw.replace(/^import [^;]*;$/gm, '').replace(/^export default /m, 'const __default = ').replace(/^export /gm, '');
  src = stripTypeScriptTypes(src, { mode: 'strip' });
  const mod = new Function(...Object.keys(bound), `${src}\nreturn { ${names.join(', ')}${/__default/.test(src) ? ', __default' : ''} };`)(...Object.values(bound));
  loaded.set(name, mod);
  return mod;
}

function loadIndexes(): void {
  if (Object.keys(indexes).length) return;
  const schema = load('schema').__default as Record<string, Def>;
  indexes = Object.fromEntries(Object.entries(schema).map(([t, d]) => [t, d.__idx]));
}

type Row = Record<string, any> & { _id: string; _creationTime: number };

export function memoryBackend() {
  loadIndexes();
  const tables: Record<string, Row[]> = {};
  const files = new Set<string>();
  const deleted: string[] = [];
  let next = 0;
  const all = (t: string) => (tables[t] ??= []);
  const get = (row: Row, f: string) => f.split('.').reduce<any>((a, k) => a?.[k], row);
  const cmp = (a: unknown, b: unknown) => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : (a as any) < (b as any) ? -1 : 1);

  // Rows read by queries (what Convex's read limits count), for tests that a
  // function reads only what it should, and their bytes (as JSON, close to
  // Convex's own size), for its 16 MiB a mutation.
  const counter = { reads: 0, bytes: 0 };
  const read = (r: Row) => {
    counter.reads++;
    counter.bytes += Buffer.byteLength(JSON.stringify(r));
  };
  const find = (id: string) => Object.values(tables).flat().find((x) => x._id === id) ?? null;
  const db = {
    query(table: string) {
      const preds: ((r: Row) => boolean)[] = [];
      let order: string[] = [];
      let desc = false;
      const range = {
        eq: (f: string, x: unknown) => (preds.push((r) => get(r, f) === x), range),
        gt: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) > x), range),
        gte: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) >= x), range),
        lt: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) < x), range),
        lte: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) <= x), range),
      };
      const rows = () => {
        const out = all(table).filter((r) => preds.every((p) => p(r)));
        if (order.length) out.sort((a, b) => order.reduce((c, f) => c || cmp(get(a, f), get(b, f)), 0) || a._creationTime - b._creationTime);
        return desc ? out.reverse() : out;
      };
      const q = {
        withIndex(name: string, fn?: (r: typeof range) => unknown) {
          const fields = name === 'by_creation_time' ? ['_creationTime'] : indexes[table]?.[name];
          if (!fields) throw new Error(`convex-memory: no index ${table}.${name}`);
          order = fields;
          fn?.(range);
          return q;
        },
        filter(fn: (b: any) => (r: Row) => boolean) {
          const field = (f: string) => ({ field: f });
          const val = (x: any, r: Row) => (x && typeof x === 'object' && 'field' in x ? get(r, x.field) : x);
          preds.push(fn({ field, eq: (a: any, b: any) => (r: Row) => val(a, r) === val(b, r) }));
          return q;
        },
        order(d: 'asc' | 'desc') {
          desc = d === 'desc';
          return q;
        },
        async first() {
          const r = rows()[0] ?? null;
          if (r) read(r);
          return r;
        },
        async unique() {
          const r = rows();
          r.forEach(read);
          if (r.length > 1) throw new Error(`convex-memory: unique() found ${r.length} rows in ${table}`);
          return r[0] ?? null;
        },
        async collect() {
          const r = rows();
          r.forEach(read);
          return r;
        },
        async take(n: number) {
          // Convex refuses a count that isn't a whole number.
          if (!Number.isInteger(n) || n < 0) throw new Error(`convex-memory: take(${n})`);
          const r = rows().slice(0, n);
          r.forEach(read);
          return r;
        },
        // A page in the index's order, its cursor the last row's key, as
        // Convex's are: rows deleted along the way don't shift the next page.
        async paginate({ numItems, cursor }: { numItems: number; cursor: string | null }) {
          const keyOf = (r: Row) => [...order.map((f) => get(r, f)), r._creationTime];
          const after = (k: unknown[], c: unknown[]) => k.reduce<number>((acc, x, i) => acc || cmp(x, c[i]), 0) > 0;
          const last = cursor ? (JSON.parse(cursor) as unknown[]) : undefined;
          const all = rows().filter((r) => !last || after(keyOf(r), last));
          const page = all.slice(0, numItems);
          page.forEach(read);
          const end = page.at(-1);
          return { page, isDone: page.length >= all.length, continueCursor: end ? JSON.stringify(keyOf(end)) : (cursor ?? '') };
        },
        async *[Symbol.asyncIterator]() {
          for (const r of rows()) {
            read(r);
            yield r;
          }
        },
      };
      return q;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      const _id = `${table}:${++next}`;
      all(table).push({ ...doc, _id, _creationTime: next } as Row);
      return _id;
    },
    // A get counts toward the bytes, not the rows (reads() is queries' rows).
    async get(id: string) {
      const r = find(id);
      if (r) counter.bytes += Buffer.byteLength(JSON.stringify(r));
      return r;
    },
    async patch(id: string, p: Record<string, unknown>) {
      const row = find(id);
      if (!row) throw new Error(`convex-memory: no row ${id}`);
      for (const [k, x] of Object.entries(p)) {
        if (x === undefined) delete row[k];
        else row[k] = x;
      }
    },
    async replace(id: string, doc: Record<string, unknown>) {
      const row = find(id);
      if (!row) throw new Error(`convex-memory: no row ${id}`);
      for (const k of Object.keys(row)) if (k !== '_id' && k !== '_creationTime') delete row[k];
      Object.assign(row, doc);
    },
    async delete(id: string) {
      for (const t of Object.keys(tables)) tables[t] = tables[t]!.filter((r) => r._id !== id);
    },
    system: { get: async (id: string) => (files.has(id) ? { _id: id } : null) },
    normalizeId: (table: string, id: string) => (id.startsWith(`${table}:`) ? id : null),
  };
  const storage = {
    async generateUploadUrl() {
      return 'https://upload.example/';
    },
    async getUrl(id: string) {
      return files.has(id) ? `https://files.example/${id}` : null;
    },
    async delete(id: string) {
      deleted.push(id);
      files.delete(id);
    },
  };
  const scheduled: unknown[] = [];
  const ctx = { db, storage, scheduler: { runAfter: async (_ms: number, fn: unknown, args: unknown) => void scheduled.push({ fn: String(fn), args }) } };
  return {
    ctx,
    rows: (t: string) => all(t),
    file: (id: string) => (files.add(id), id),
    hasFile: (id: string) => files.has(id),
    deleted,
    scheduled,
    reads: () => counter.reads,
    bytesRead: () => counter.bytes,
    resetReads: () => ((counter.reads = 0), (counter.bytes = 0)),
  };
}

/** Calls a function as the deployment would: its handler with ctx and args. */
export async function call(ctx: unknown, fn: { handler: (ctx: any, args: any) => unknown }, args: Record<string, unknown>): Promise<any> {
  return fn.handler(ctx, args);
}

/** The ConvexError kind a call threw, or "ok". */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const kind = (e as { data?: { kind?: string } }).data?.kind;
    if (kind) return kind;
    throw e;
  }
}
