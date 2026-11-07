// A project's task board, read from Notion (docs/protocol.md, "Project
// tasks"). A project can name a Notion page (or a database); the runner
// finds the task database on it and reads its rows every few minutes
// through Mike's Connectors gateway (connectors.ts), the same Notion login
// his agents use, so there's no Notion key of its own to keep. Notion stays
// the one place tasks are changed: people edit the board there and agents
// move cards with the Notion tools. Threadbear only shows it.
//
// The gateway speaks MCP over HTTP. Each read is three tool calls at most
// (the page, the database's schema, its rows), stateless, with the
// Authorization header the main Claude login's `headersHelper` prints.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './log.ts';
import type { ProjectTask, ProjectTasks, TaskColumn } from './protocol.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { isSpace, seeker } from './linear-text.ts';
import { credentialUrlProblem } from './secure-url.ts';

// How often a board is read when nobody's asking. Opening the project page
// asks again once it's older than FRESH_MS.
export const POLL_MS = 5 * 60_000;
export const FRESH_MS = 60_000;
const TIMEOUT_MS = 30_000;
// A view query returns at most 100 a page; a board reads this many pages
// at most, and says when there are more.
const PAGE_SIZE = 100;
const PAGES_MAX = 3;
// The columns change rarely: the schema is fetched again after this, or
// when a card turns up in a column it didn't list.
const SCHEMA_MS = 30 * 60_000;
// Boards read at once. The gateway allows 32 calls in flight for everyone
// (agents included), and 73 boards read together every 5 minutes went
// past it (30 Oct); a few at a time still reads them all in seconds.
export const READS_AT_ONCE = 3;

// ------------------------------------------------------------- the gateway

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

// Calls one of the gateway's tools and gives back its text. The answer is
// JSON or a one-event SSE stream, depending on the gateway's mood.
//
// The headers are the gateway's token: only to https, or plain http to this
// Mac (secure-url.ts), and never a redirect, so a 307 can't send the call on
// somewhere else. The gateway's sign-in pages are links Mike opens in his
// browser, never followed from here.
export function gatewayCaller(opts: { mcpUrl: string; headers: () => Promise<Record<string, string>>; fetch?: typeof fetch }): CallTool {
  const f = opts.fetch ?? fetch;
  const problem = credentialUrlProblem(opts.mcpUrl);
  let id = 0;
  return async (name, args) => {
    if (problem) throw new Error(`The Connectors gateway URL ${problem}.`);
    const res = await f(opts.mcpUrl, {
      method: 'POST',
      headers: { ...(await opts.headers()), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
    const msg = parseRpc(await res.text());
    if (msg.error) throw new Error(msg.error.message ?? 'the gateway gave an error');
    const text = (msg.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (msg.result?.isError) throw new Error(signInLine(text) ?? (text.slice(0, 300) || 'Notion gave an error'));
    return text;
  };
}

type RpcMessage = { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };

export function parseRpc(body: string): RpcMessage {
  const t = body.trim();
  if (t.startsWith('{')) return JSON.parse(t) as RpcMessage;
  // SSE: the last `data:` line is the answer.
  const data = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  if (!data.length) throw new Error("the gateway's answer wasn't JSON");
  return JSON.parse(data[data.length - 1]!) as RpcMessage;
}

// "Notion needs signing in again..." is worth showing as it is.
function signInLine(text: string): string | undefined {
  const line = text.split('\n').find((l) => /sign(ed)? in|sign_in/i.test(l));
  return line?.trim().slice(0, 300);
}

// The Authorization header the main login's connectors entry gets, from
// its headersHelper (install-clients.sh writes one that reads the token
// from the Keychain). The helper prints a JSON object of headers.
export function helperHeaders(command: string): () => Promise<Record<string, string>> {
  return () =>
    new Promise((resolve, reject) => {
      execFile('/bin/sh', ['-c', command], { timeout: 10_000 }, (err, stdout) => {
        if (err) return reject(new Error('the connectors headers helper failed'));
        try {
          const h = JSON.parse(stdout) as Record<string, unknown>;
          resolve(Object.fromEntries(Object.entries(h).filter((e): e is [string, string] => typeof e[1] === 'string')));
        } catch {
          reject(new Error("the connectors headers helper didn't print JSON"));
        }
      });
    });
}

// The gateway's MCP URL and headers helper from the main login's
// ~/.claude.json, as connectors.ts finds its base. runner.json's
// connectors.headersHelper wins for the helper.
export function findGatewayClient(raw: { url?: unknown; enabled?: unknown; headersHelper?: unknown } | undefined, claudeJsonPath: string): { mcpUrl: string; headersHelper: string } | undefined {
  if (raw?.enabled === false) return undefined;
  let entry: { url?: unknown; headersHelper?: unknown } | undefined;
  try {
    entry = (JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as { mcpServers?: Record<string, { url?: unknown; headersHelper?: unknown }> })?.mcpServers?.connectors;
  } catch {
    entry = undefined;
  }
  const url = typeof raw?.url === 'string' && raw.url.trim() ? raw.url.trim() : entry?.url;
  const helper = typeof raw?.headersHelper === 'string' && raw.headersHelper.trim() ? raw.headersHelper.trim() : entry?.headersHelper;
  if (typeof url !== 'string' || typeof helper !== 'string' || !url || !helper) return undefined;
  // Its calls carry the token the helper prints (secure-url.ts).
  if (credentialUrlProblem(url)) return undefined;
  try {
    const u = new URL(url);
    // A bare base (https://host:8443) means its /mcp.
    const mcpUrl = u.pathname === '/' ? new URL('/mcp', u).href : u.href;
    return { mcpUrl, headersHelper: helper };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------- reading Notion

// What Notion's fetch tool gives back: JSON with the entity in `text`.
type Fetched = { metadata?: { type?: string }; title?: string; url?: string; text?: string };

// Where a project's tasks are: the database to open, its data source, and
// one of its views. Rows are read through the view: Notion caps rows and
// SQL queries per workspace (an allowance a few dozen boards used up in
// minutes, 30 Oct), and view queries don't count against it.
export type TaskSource = { dataSource: string; databaseUrl?: string; view?: string };

// Finds the task database from what a project names: a database (its first
// data source), a data source, or a page with a database on it (the one
// called Tasks, or the first).
export async function findSource(call: CallTool, url: string): Promise<TaskSource> {
  if (url.startsWith('collection://')) return { dataSource: url };
  const f = JSON.parse(await call('notion__notion-fetch', { id: url })) as Fetched;
  const text = f.text ?? '';
  const type = f.metadata?.type;
  if (type === 'database') {
    const ds = text.match(/<data-source url="\{*(collection:\/\/[0-9a-f-]+)\}*"/)?.[1];
    if (!ds) throw new Error('That Notion database has no data source Threadbear can read.');
    const view = pickView(text);
    return { dataSource: ds, databaseUrl: cleanUrl(f.url ?? url), ...(view ? { view } : {}) };
  }
  if (type === 'data_source') {
    const ds = text.match(/<data-source url="\{*(collection:\/\/[0-9a-f-]+)\}*"/)?.[1] ?? '';
    return { dataSource: ds, databaseUrl: f.url ? cleanUrl(f.url) : undefined };
  }
  const dbs = databasesIn(text);
  if (!dbs.length) throw new Error('No database on that Notion page. Add a Tasks database to it (a board grouped by Status).');
  const pick = dbs.find((d) => /^tasks?$/i.test(d.title)) ?? dbs.find((d) => /task/i.test(d.title)) ?? dbs[0]!;
  // The page names the database; the database lists its views.
  const db = JSON.parse(await call('notion__notion-fetch', { id: pick.url })) as Fetched;
  const view = pickView(db.text ?? '');
  return { dataSource: pick.dataSource, databaseUrl: cleanUrl(pick.url), ...(view ? { view } : {}) };
}

// Each `<database url="…" data-source-url="collection://…" …>title</database>`
// on a page, as
// `/<database url="([^"]+)" data-source-url="(collection:\/\/[0-9a-f-]+)"[^>]*>\s*([^<]*?)\s*<\/database>/g`
// found them, with the title trimmed. The tag's ">" and the title's "<" are
// each looked for once (seeker), as that regex scanned to the end again from
// every tag with no ">" after it, and tried every split of a title's spaces.
function databasesIn(text: string): { url: string; dataSource: string; title: string }[] {
  const out: { url: string; dataSource: string; title: string }[] = [];
  const OPEN = '<database url="';
  const CLOSE = '</database>';
  const head = /<database url="([^"]+)" data-source-url="(collection:\/\/[0-9a-f-]+)"/y;
  const tagEnd = seeker(text, (c) => c === '>');
  const titleEnd = seeker(text, (c) => c === '<');
  for (let p = text.indexOf(OPEN); p >= 0; ) {
    head.lastIndex = p;
    const m = head.exec(text);
    let end = -1;
    if (m) {
      const gt = tagEnd(p + m[0].length);
      if (gt < 0) break; // no ">" after this tag, nor after any later one
      const lt = titleEnd(gt + 1);
      if (lt >= 0 && text.startsWith(CLOSE, lt)) {
        out.push({ url: m[1]!, dataSource: m[2]!, title: text.slice(gt + 1, lt).trim() });
        end = lt + CLOSE.length;
      }
    }
    p = text.indexOf(OPEN, end >= 0 ? end : p + 1);
  }
  return out;
}

// A view of the database to read rows through: one with no filter, so no
// card is hidden, else none (rows are then read straight, which counts
// against the allowance).
export function pickView(databaseText: string): string | undefined {
  for (const [url, json] of views(databaseText)) {
    let config: Record<string, unknown> = {};
    try {
      // The fetch tool wraps ids in {{ }}, inside the JSON's strings too.
      config = JSON.parse(unwrapIds(json)) as Record<string, unknown>;
    } catch {
      // A view we can't read is no worse than one with a filter: skip it.
      continue;
    }
    if (!config.filter && !config.filters) return url;
  }
  return undefined;
}

// `s.replace(/\{\{(\w+:\/\/[^}]*)\}\}/g, '$1')`, reading the text once:
// that regex scanned to the end from every "{{" with no "}" after it.
function unwrapIds(s: string): string {
  const nextBrace = seeker(s, (c) => c === '}');
  let out = '';
  let copied = 0;
  for (let p = s.indexOf('{{'); p >= 0; ) {
    let i = p + 2;
    while (i < s.length && /\w/.test(s[i]!)) i++;
    const k = i > p + 2 && s.startsWith('://', i) ? nextBrace(i + 3) : -1;
    if (k >= 0 && s[k + 1] === '}') {
      out += s.slice(copied, p) + s.slice(p + 2, k);
      copied = k + 2;
      p = s.indexOf('{{', copied);
    } else p = s.indexOf('{{', p + 1);
  }
  return copied ? out + s.slice(copied) : s;
}

// Each `<view url="{{view://…}}"> {…} </view>`: its id and its JSON, as
// `/<view url="\{*(view:\/\/[0-9a-f-]+)\}*">\s*(\{[\s\S]*?\})\s*<\/view>/g`
// found them, but without scanning to the end again from every view that
// isn't closed. A view's JSON runs from the "{" after its tag to the first
// "</view>" with only a "}" and whitespace before it.
function views(text: string): [string, string][] {
  const out: [string, string][] = [];
  const CLOSE = '</view>';
  // The next "</view>" at or after a place whose JSON could end there, kept
  // as the views are read in order.
  let close = -1;
  const closesJson = (c: number) => {
    let b = c - 1;
    while (b >= 0 && isSpace(text[b])) b--;
    return text[b] === '}';
  };
  const open = /<view url="\{*(view:\/\/[0-9a-f-]+)\}*">/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    let start = m.index + m[0].length;
    while (start < text.length && isSpace(text[start])) start++;
    if (text[start] !== '{') continue;
    if (close <= start && close !== -2) {
      close = text.indexOf(CLOSE, start + 1);
      while (close >= 0 && !closesJson(close)) close = text.indexOf(CLOSE, close + 1);
      if (close < 0) close = -2; // none from here on
    }
    if (close === -2) break;
    let b = close - 1;
    while (isSpace(text[b])) b--;
    out.push([m[1]!, text.slice(start, b + 1)]);
    open.lastIndex = close + CLOSE.length;
  }
  return out;
}

type SchemaProp = {
  name: string;
  type: string;
  options?: { name: string; color?: string }[];
  groups?: Record<string, { name: string; color?: string }[]>;
};

// Which of the database's properties are which, by type and then by name.
export type Board = {
  title: string;
  status?: string;
  columns: TaskColumn[];
  who?: string;
  due?: string;
  thread?: string;
};

export function readSchema(fetchedText: string): Board {
  const f = JSON.parse(fetchedText) as Fetched;
  const json = between(f.text ?? '', '<data-source-state>', '</data-source-state>')?.trim();
  if (!json) throw new Error("Couldn't read the task database's columns.");
  const props = Object.values((JSON.parse(json) as { schema?: Record<string, SchemaProp> }).schema ?? {});
  const title = props.find((p) => p.type === 'title')?.name ?? 'Name';
  // Status: a status property (Notion's own To do / In progress / Complete
  // groups), else a select called Status.
  const statusProp = props.find((p) => p.type === 'status') ?? props.find((p) => p.type === 'select' && /status|stage|state/i.test(p.name));
  const columns: TaskColumn[] = [];
  if (statusProp?.groups) {
    for (const [group, kind] of [['to_do', 'todo'], ['in_progress', 'doing'], ['complete', 'done']] as const) {
      for (const o of statusProp.groups[group] ?? []) columns.push({ name: o.name, kind, ...(o.color ? { color: o.color } : {}) });
    }
  } else if (statusProp?.options) {
    for (const o of statusProp.options) columns.push({ name: o.name, kind: /done|complete|shipped|closed/i.test(o.name) ? 'done' : /doing|progress|review|wait/i.test(o.name) ? 'doing' : 'todo', ...(o.color ? { color: o.color } : {}) });
  }
  const people = props.filter((p) => p.type === 'multi_select' || p.type === 'person' || p.type === 'people' || (p.type === 'select' && p !== statusProp));
  const who = people.find((p) => /who|assign|owner|people|person/i.test(p.name)) ?? people.find((p) => p.type === 'person' || p.type === 'people');
  const dates = props.filter((p) => p.type === 'date');
  const due = dates.find((p) => /due|when|date/i.test(p.name)) ?? dates[0];
  const thread = props.find((p) => p.type === 'text' && /thread/i.test(p.name));
  return {
    title,
    columns,
    ...(statusProp ? { status: statusProp.name } : {}),
    ...(who ? { who: who.name } : {}),
    ...(due ? { due: due.name } : {}),
    ...(thread ? { thread: thread.name } : {}),
  };
}

type Row = Record<string, unknown>;

export function readRows(text: string, board: Board): { items: ProjectTask[]; more: boolean } {
  const parsed = JSON.parse(text) as { results?: Row[]; has_more?: boolean };
  const items: ProjectTask[] = [];
  for (const r of parsed.results ?? []) {
    const url = typeof r.url === 'string' ? cleanUrl(r.url) : undefined;
    const title = cleanTitle(asText(r[board.title]));
    if (!url || !title) continue;
    const id = url.match(/([0-9a-f]{32})/)?.[1] ?? url;
    const t: ProjectTask = { id, title, url, status: board.status ? asText(r[board.status]) : '', who: board.who ? asList(r[board.who]) : [] };
    if (board.due) {
      const start = asText(r[`date:${board.due}:start`]);
      const end = asText(r[`date:${board.due}:end`]);
      if (start) t.due = start;
      if (end) t.dueEnd = end;
    }
    if (board.thread) {
      const th = asText(r[board.thread]).trim();
      if (th) t.thread = th;
    }
    items.push(t);
  }
  return { items, more: Boolean(parsed.has_more) };
}

// The rows, through the view a page at a time when there is one.
async function readAllRows(call: CallTool, source: TaskSource, board: Board): Promise<{ items: ProjectTask[]; more: boolean }> {
  if (!source.view) {
    return readRows(await call('notion__notion-query-data-sources', { data: { mode: 'rows', data_source_url: source.dataSource, limit: PAGE_SIZE } }), board);
  }
  const items: ProjectTask[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PAGES_MAX; page++) {
    const text = await call('notion__notion-query-data-sources', { data: { mode: 'view', view_url: source.view, page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) } });
    items.push(...readRows(text, board).items);
    const page_ = JSON.parse(text) as { has_more?: unknown; next_cursor?: unknown };
    cursor = page_.has_more && typeof page_.next_cursor === 'string' ? page_.next_cursor : undefined;
    if (!cursor) return { items, more: false };
  }
  return { items, more: true };
}

// Reads the whole board: where it is, its columns (unless `board` is still
// good) and its rows.
export async function readTasks(
  call: CallTool,
  notionUrl: string,
  known?: TaskSource,
  cached?: Board,
): Promise<{ source: TaskSource; board: Board; tasks: Omit<ProjectTasks, 'fetchedAt'> }> {
  const source = known ?? (await findSource(call, notionUrl));
  let board = cached ?? readSchema(await call('notion__notion-fetch', { id: source.dataSource }));
  let { items, more } = await readAllRows(call, source, board);
  // A card in a column the cached schema doesn't have: the columns
  // changed, so read them again.
  if (cached && items.some((t) => t.status && !board.columns.some((c) => c.name === t.status))) {
    board = readSchema(await call('notion__notion-fetch', { id: source.dataSource }));
    ({ items, more } = await readAllRows(call, source, board));
  }
  // Statuses the schema didn't list (a select with a new option) still
  // get a column, at the end.
  const columns = [...board.columns];
  for (const t of items) if (t.status && !columns.some((c) => c.name === t.status)) columns.push({ name: t.status, kind: 'todo' });
  return {
    source,
    board,
    tasks: {
      url: source.databaseUrl ?? notionUrl,
      columns,
      items,
      ...(more ? { more: true } : {}),
    },
  };
}

// What's between the first `open` and the first `close` after it, by
// indexOf, not a lazy regex that tries every split of the spaces around it.
function between(text: string, open: string, close: string): string | undefined {
  const o = text.indexOf(open);
  if (o < 0) return undefined;
  const c = text.indexOf(close, o + open.length);
  return c < 0 ? undefined : text.slice(o + open.length, c);
}

// Notion sometimes hands back a title wrapped in a paragraph, which showed as
// "<p> WIN TV Book in TVC </p>" on the card. Only the wrapper goes, so a title
// about <div>s keeps its words.
//
// By hand, as `/^\s*<p(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/p>\s*$/i` did it: a
// paragraph's opening tag at the start and its "</p>" at the end, with
// the words between them. That regex was cubic in a run of spaces.
export function cleanTitle(title: string): string {
  const s = title.trim();
  if (s.slice(0, 2).toLowerCase() !== '<p' || s.slice(-4).toLowerCase() !== '</p>') return s;
  const open = s[2] === '>' ? 2 : isSpace(s[2]) ? s.indexOf('>', 3) : -1;
  const close = s.length - 4;
  return open >= 0 && open < close ? s.slice(open + 1, close).trim() : s;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

// Multi-selects come as a JSON list in a string; people as user:// urls.
function asList(v: unknown): string[] {
  let list: unknown = v;
  if (typeof v === 'string') {
    try {
      list = v.trim().startsWith('[') ? JSON.parse(v) : v ? [v] : [];
    } catch {
      list = [v];
    }
  }
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && Boolean(x)).map((x) => x.replace(/^user:\/\//, '')) : [];
}

// Notion's links carry ?pvs=204 and {{ }} from the fetch tool.
function cleanUrl(u: string): string {
  return u.replace(/[{}]/g, '').replace(/\?pvs=\d+$/, '');
}

// ------------------------------------------------------------- the boards

type Timer = { cancel(): void };

export type TaskBoardsOptions = {
  home: string; // the runner's data dir: project-tasks.json is kept there
  call?: CallTool; // none: no gateway, every board says so
  log: Pick<Logger, 'info' | 'error'>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  onChange: (projectId: string) => void;
};

type Saved = { notion: string; source?: TaskSource; board?: Board; boardAt?: number; tasks?: ProjectTasks };

// Keeps each project's board, read now and then, and remembers the last
// one across restarts so the page isn't empty while the first read runs.
export class TaskBoards {
  private boards = new Map<string, Saved>();
  private inFlight = new Map<string, Promise<void>>();
  private timer?: Timer;
  private file: string;
  private now: () => number;
  private wanted: () => { id: string; notion?: string }[] = () => [];
  private opts: TaskBoardsOptions;
  // Reads waiting for one of the READS_AT_ONCE places.
  private reading = 0;
  private queue: (() => void)[] = [];

  constructor(opts: TaskBoardsOptions) {
    this.opts = opts;
    this.file = path.join(opts.home, 'project-tasks.json');
    this.now = opts.now ?? Date.now;
    const saved = readJsonSync<{ boards?: Record<string, Saved> }>(this.file);
    for (const [id, b] of Object.entries(saved?.boards ?? {})) if (b && typeof b.notion === 'string') this.boards.set(id, b);
  }

  // `projects` lists the projects and their Notion page each time it's
  // asked, so a project that gains or loses one is picked up.
  start(projects: () => { id: string; notion?: string }[]): void {
    this.wanted = projects;
    this.tick();
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  // What the project page shows, if the project has a Notion page.
  get(projectId: string, notion: string | undefined): ProjectTasks | undefined {
    if (!notion) return undefined;
    const b = this.boards.get(projectId);
    if (!b || b.notion !== notion) return { url: notion, columns: [], items: [], loading: true };
    return b.tasks ?? { url: notion, columns: [], items: [], loading: true };
  }

  // Reads one board now, unless it was read within FRESH_MS (force skips
  // that). One read per project at a time; a second ask joins it.
  refresh(projectId: string, notion: string | undefined, force = false): Promise<void> {
    if (!notion) {
      if (this.boards.delete(projectId)) this.save();
      return Promise.resolve();
    }
    const b = this.boards.get(projectId);
    const at = b?.tasks?.fetchedAt ? Date.parse(b.tasks.fetchedAt) : 0;
    if (!force && b?.notion === notion && this.now() - at < FRESH_MS && !b.tasks?.error) return Promise.resolve();
    const running = this.inFlight.get(projectId);
    if (running) return running;
    const p = this.limited(() => this.read(projectId, notion)).finally(() => this.inFlight.delete(projectId));
    this.inFlight.set(projectId, p);
    return p;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.reading >= READS_AT_ONCE) await new Promise<void>((go) => this.queue.push(go));
    this.reading++;
    try {
      return await fn();
    } finally {
      this.reading--;
      this.queue.shift()?.();
    }
  }

  private async read(projectId: string, notion: string): Promise<void> {
    const before = this.boards.get(projectId);
    // A source saved before views were read through has none: find it again.
    const same = before?.notion === notion ? before : undefined;
    const known = same?.source && (same.source.view || notion.startsWith('collection://')) ? same.source : undefined;
    const cached = known && same?.board && this.now() - (same.boardAt ?? 0) < SCHEMA_MS ? same.board : undefined;
    const fetchedAt = new Date(this.now()).toISOString();
    let next: Saved;
    if (!this.opts.call) {
      next = { notion, tasks: { url: notion, columns: [], items: [], fetchedAt, error: 'Threadbear reads Notion through the Connectors gateway, and none is set up.' } };
    } else {
      try {
        const { source, board, tasks } = await readTasks(this.opts.call, notion, known, cached);
        next = { notion, source, board, boardAt: board === cached ? same!.boardAt : this.now(), tasks: { ...tasks, fetchedAt } };
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        // Notion's own wording is long and ends in a sales link.
        const error = /allowance/i.test(raw) ? "Notion's query limit for this workspace is used up for now. It resets within the hour." : raw;
        this.opts.log.info('project tasks not read', { projectId, error });
        // Keep the last good board, with the error over it; forget where
        // it was, in case the database moved.
        const kept = before?.notion === notion ? before.tasks : undefined;
        next = { notion, tasks: { url: kept?.url ?? notion, columns: kept?.columns ?? [], items: kept?.items ?? [], fetchedAt, error } };
      }
    }
    const changed = JSON.stringify({ ...before?.tasks, fetchedAt: '' }) !== JSON.stringify({ ...next.tasks, fetchedAt: '' }) || before?.notion !== notion;
    this.boards.set(projectId, next);
    this.save();
    if (changed) this.opts.onChange(projectId);
  }

  private tick(): void {
    const live = this.wanted();
    // Forget boards of projects that no longer have a page.
    let dropped = false;
    for (const id of [...this.boards.keys()]) {
      if (!live.some((p) => p.id === id && p.notion)) {
        this.boards.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.save();
    for (const p of live) if (p.notion) void this.refresh(p.id, p.notion).catch(() => {});
    const set = this.opts.setTimeout ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
    this.timer = set(() => this.tick(), POLL_MS);
  }

  private save(): void {
    try {
      atomicWriteFileSync(this.file, JSON.stringify({ boards: Object.fromEntries(this.boards) }, null, 2));
    } catch (e) {
      this.opts.log.error('project-tasks.json not saved', { error: String(e) });
    }
  }
}
