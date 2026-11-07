import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { downgradeFetch, redirectTrap } from '../helpers/redirect-trap.ts';
import { READS_AT_ONCE, TaskBoards, cleanTitle, findGatewayClient, findSource, gatewayCaller, parseRpc, readSchema, readRows, readTasks, type CallTool } from '../../src/notion-tasks.ts';
import { Projects, checkNotion, projectMethods } from '../../src/projects.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { RpcError } from '../../src/protocol.ts';

// docs/protocol.md, "Project tasks". The shapes below are what Notion's
// MCP tools give back through the gateway (30 Oct 2026), cut down.

const PAGE = 'https://app.notion.com/p/3fefd70ecfa0815bbd83cf6b315c6511';
const DB = 'https://app.notion.com/p/94471028e3bb4e2a810d117d5b8f19fd';
const DS = 'collection://58c0e1f3-c4b0-42a1-8251-0467912303fe';

const pageFetch = JSON.stringify({
  metadata: { type: 'page' },
  title: 'Christmas Lights 2026',
  url: PAGE + '?pvs=204',
  text: `<page url="${PAGE}"><content>\n## Notes\n\n<database url="https://app.notion.com/p/1111" data-source-url="collection://11111111-2222-3333-4444-555555555555" inline="true">\nContacts\n</database>\n\n<database url="${DB}" data-source-url="${DS}" inline="true">\nTasks\n</database>\n</content></page>`,
});

const schema = {
  name: 'Tasks',
  schema: {
    Due: { name: 'Due', type: 'date' },
    Name: { name: 'Name', type: 'title' },
    Status: {
      name: 'Status',
      type: 'status',
      groups: {
        complete: [{ name: 'Done', color: 'green' }],
        in_progress: [{ name: 'Doing', color: 'blue' }, { name: 'Waiting', color: 'orange' }],
        to_do: [{ name: 'To do', color: 'gray' }],
      },
    },
    Thread: { name: 'Thread', type: 'text' },
    Who: { name: 'Who', type: 'multi_select', options: [{ name: 'Mike' }, { name: 'Zaran' }] },
  },
};
const dsFetch = JSON.stringify({ metadata: { type: 'data_source' }, title: 'Tasks', url: DB + '?pvs=204', text: `<data-source url="{{${DS}}}">\n<data-source-state>\n${JSON.stringify(schema)}\n</data-source-state>\n</data-source>` });

const rows = JSON.stringify({
  results: [
    { Name: 'Eventbrite link for the tickets page', Status: 'Waiting', Who: '["Zaran"]', Thread: '', 'date:Due:is_datetime': 0, url: 'https://app.notion.com/p/409fd70ecfa081f0b5b2f98d9baf2090' },
    { Name: 'Fixes from the 30 Oct reply', Status: 'Doing', Who: '["Mike"]', Thread: '60f772ab', url: 'https://app.notion.com/p/409fd70ecfa081509451d31e424fe69e' },
    { Name: 'Sign collection', Status: 'Waiting', Who: '["Zaran","Tracy"]', 'date:Due:start': '2026-11-29', 'date:Due:end': '2026-12-04', url: 'https://app.notion.com/p/409fd70ecfa081fb8560d5ec70d1c067' },
    { Name: '', Status: 'To do', url: 'https://app.notion.com/p/409fd70ecfa0000000000000000000ff' },
  ],
  has_more: false,
});

// The database lists its views: a filtered one first, which a board must
// not read through (it would hide cards), then a plain one.
const VIEW = 'view://409fd70e-cfa0-814a-bcf7-000c11d3e829';
const dbFetch = JSON.stringify({
  metadata: { type: 'database' },
  url: DB + '?pvs=204',
  text: `<database url="{{${DB}}}"><data-sources><data-source url="{{${DS}}}"></data-source></data-sources>\n<views>\n<view url="{{view://11111111-0000-0000-0000-000000000000}}">\n{"dataSourceUrl":"{{${DS}}}","name":"Mine","type":"table","filter":{"property":"Who"}}\n</view>\n<view url="{{${VIEW}}}">\n{"dataSourceUrl":"{{${DS}}}","name":"Board","type":"board","groupBy":{"property":"Status"}}\n</view>\n</views></database>`,
});

// A fake gateway: answers by tool and id, and counts what it was asked.
// Row queries through a view answer `view`; straight ones `rows`.
function fakeNotion(over: Partial<Record<string, string | Error>> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const answers: Record<string, string | Error> = { [PAGE]: pageFetch, [DB]: dbFetch, [DS]: dsFetch, rows, view: rows, ...over };
  const call: CallTool = async (name, args) => {
    calls.push({ name, args });
    const mode = (args.data as { mode?: string } | undefined)?.mode;
    const key = name === 'notion__notion-query-data-sources' ? (mode === 'view' ? 'view' : 'rows') : String(args.id);
    const a = answers[key];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`nothing for ${key}`);
    return a;
  };
  return { call, calls, answers };
}

test('the gateway answers as SSE or JSON; a tool error says what Notion said', async () => {
  assert.deepEqual(parseRpc('event: message\ndata: {"result":{"content":[{"type":"text","text":"hi"}]},"jsonrpc":"2.0","id":1}\n\n').result?.content?.[0]?.text, 'hi');
  assert.equal(parseRpc('{"error":{"message":"nope"}}').error?.message, 'nope');
  const asked: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const reply = (body: unknown) => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200 });
  let next: unknown = { result: { content: [{ type: 'text', text: '{"ok":1}' }] } };
  const call = gatewayCaller({
    mcpUrl: 'https://bruce:8443/mcp',
    headers: async () => ({ Authorization: 'Bearer t' }),
    fetch: (async (url: string, init: RequestInit) => {
      asked.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return reply(next);
    }) as typeof fetch,
  });
  assert.equal(await call('notion__notion-fetch', { id: 'x' }), '{"ok":1}');
  assert.equal(asked[0]!.url, 'https://bruce:8443/mcp');
  assert.equal(asked[0]!.headers.Authorization, 'Bearer t');
  assert.deepEqual((asked[0]!.body as { params: unknown }).params, { name: 'notion__notion-fetch', arguments: { id: 'x' } });
  next = { result: { isError: true, content: [{ type: 'text', text: 'Notion needs signing in again. Ask Mike to open https://bruce/admin/connect/notion' }] } };
  await assert.rejects(call('notion__notion-fetch', { id: 'x' }), /Notion needs signing in again/);
});

test("a page's Tasks database is the board, over any other database on it", async () => {
  const n = fakeNotion();
  assert.deepEqual(await findSource(n.call, PAGE), { dataSource: DS, databaseUrl: DB, view: VIEW });
  // A database names its own data source and views.
  assert.deepEqual(await findSource(fakeNotion().call, DB), { dataSource: DS, databaseUrl: DB, view: VIEW });
  // With only filtered views, there's no view to read through.
  const filtered = JSON.stringify({ metadata: { type: 'database' }, url: DB, text: `<data-source url="{{${DS}}}"></data-source><view url="{{view://11111111-0000-0000-0000-000000000000}}">\n{"filter":{"property":"Who"}}\n</view>` });
  assert.deepEqual(await findSource(fakeNotion({ [DB]: filtered }).call, DB), { dataSource: DS, databaseUrl: DB });
  // A page with no database says what to add.
  const bare = JSON.stringify({ metadata: { type: 'page' }, text: '<page><content>Hi</content></page>' });
  await assert.rejects(findSource(fakeNotion({ [PAGE]: bare }).call, PAGE), /No database on that Notion page/);
});

test("the columns are the Status options in Notion's group order; Who, Due and Thread are found by type and name", () => {
  const b = readSchema(dsFetch);
  assert.deepEqual(b.columns, [
    { name: 'To do', kind: 'todo', color: 'gray' },
    { name: 'Doing', kind: 'doing', color: 'blue' },
    { name: 'Waiting', kind: 'doing', color: 'orange' },
    { name: 'Done', kind: 'done', color: 'green' },
  ]);
  assert.equal(b.title, 'Name');
  assert.equal(b.status, 'Status');
  assert.equal(b.who, 'Who');
  assert.equal(b.due, 'Due');
  assert.equal(b.thread, 'Thread');
});

test('rows become cards: people as a list, a date range kept, untitled rows skipped', () => {
  const { items, more } = readRows(rows, readSchema(dsFetch));
  assert.equal(more, false);
  assert.equal(items.length, 3);
  assert.deepEqual(items[1], { id: '409fd70ecfa081509451d31e424fe69e', title: 'Fixes from the 30 Oct reply', url: 'https://app.notion.com/p/409fd70ecfa081509451d31e424fe69e', status: 'Doing', who: ['Mike'], thread: '60f772ab' });
  assert.deepEqual([items[2]!.due, items[2]!.dueEnd, items[2]!.who], ['2026-11-29', '2026-12-04', ['Zaran', 'Tracy']]);
});

test('a title wrapped in a paragraph loses the wrapper, and only that', () => {
  assert.equal(cleanTitle('<p>\nWIN TV Book in TVC \n</p>'), 'WIN TV Book in TVC');
  assert.equal(cleanTitle('  Plain title '), 'Plain title');
  assert.equal(cleanTitle('Replace <p> with <div> in the footer'), 'Replace <p> with <div> in the footer');
  assert.equal(cleanTitle('<p></p>'), '');
});

test('rows are read through a view, never straight, since straight queries have a workspace allowance', async () => {
  const n = fakeNotion();
  const first = await readTasks(n.call, PAGE);
  assert.equal(first.tasks.url, DB);
  assert.equal(first.tasks.items.length, 3);
  // The page, the database (for its views), the schema, the rows.
  assert.equal(n.calls.length, 4);
  assert.deepEqual(n.calls[3]!.args, { data: { mode: 'view', view_url: VIEW, page_size: 100 } });
  assert.ok(!n.calls.some((c) => (c.args.data as { mode?: string } | undefined)?.mode === 'rows'));
  // Known source and a good schema: the rows alone.
  n.calls.length = 0;
  await readTasks(n.call, PAGE, first.source, first.board);
  assert.deepEqual(n.calls.map((c) => c.name), ['notion__notion-query-data-sources']);
  // A card in a column the cached schema lacks: the schema is read again.
  n.calls.length = 0;
  const stale = { ...first.board, columns: first.board.columns.filter((c) => c.name !== 'Waiting') };
  const again = await readTasks(n.call, PAGE, first.source, stale);
  assert.ok(again.board.columns.some((c) => c.name === 'Waiting'));
  assert.ok(n.calls.some((c) => c.args.id === DS));
});

test('a big board is read a page at a time, three pages at most', async () => {
  let page = 0;
  const call: CallTool = async (name, args) => {
    if (name === 'notion__notion-fetch') return dsFetch;
    page++;
    const cursor = (args.data as { start_cursor?: string }).start_cursor;
    assert.equal(cursor, page === 1 ? undefined : `c${page - 1}`);
    return JSON.stringify({ results: [{ Name: `Card ${page}`, Status: 'To do', url: `https://app.notion.com/p/${String(page).padStart(32, '0')}` }], has_more: true, next_cursor: `c${page}` });
  };
  const r = await readTasks(call, DS, { dataSource: DS, view: VIEW });
  assert.equal(r.tasks.items.length, 3);
  assert.equal(r.tasks.more, true);
});

test('the boards: loading at first, then the board; a failed read keeps the last good one with the error; kept across restarts', async () => {
  const home = tmpDir();
  let now = Date.parse('2026-10-30T05:00:00Z');
  const n = fakeNotion();
  const changed: string[] = [];
  const boards = new TaskBoards({ home, call: n.call, log: nullLogger, now: () => now, setTimeout: () => ({ cancel() {} }), onChange: (id) => changed.push(id) });
  assert.deepEqual(boards.get('p_1', PAGE), { url: PAGE, columns: [], items: [], loading: true });
  assert.equal(boards.get('p_1', undefined), undefined);
  await boards.refresh('p_1', PAGE);
  const t = boards.get('p_1', PAGE)!;
  assert.equal(t.items.length, 3);
  assert.equal(t.fetchedAt, '2026-10-30T05:00:00.000Z');
  assert.deepEqual(changed, ['p_1']);
  // Fresh: not asked again.
  n.calls.length = 0;
  await boards.refresh('p_1', PAGE);
  assert.equal(n.calls.length, 0);
  // Stale and failing: the last good board stays, with the error.
  now += 2 * 60_000;
  n.answers.view = new Error('Notion needs signing in again.');
  await boards.refresh('p_1', PAGE);
  const failed = boards.get('p_1', PAGE)!;
  assert.equal(failed.items.length, 3);
  assert.equal(failed.error, 'Notion needs signing in again.');
  // Notion's allowance message is long; the board says it plainly.
  now += 2 * 60_000;
  n.answers.view = new Error('Your workspace has used up its Query Data Source allowance for SQL and rows-mode queries. Learn more https://app.notion.');
  await boards.refresh('p_1', PAGE);
  assert.match(boards.get('p_1', PAGE)!.error!, /^Notion's query limit for this workspace is used up for now/);
  // A new runner starts with what was saved.
  const again = new TaskBoards({ home, call: n.call, log: nullLogger, onChange: () => {} });
  assert.equal(again.get('p_1', PAGE)!.items.length, 3);
  // A different page is a different board.
  assert.equal(again.get('p_1', DB)!.loading, true);
});

test('no gateway: a board says why it is empty', async () => {
  const boards = new TaskBoards({ home: tmpDir(), log: nullLogger, setTimeout: () => ({ cancel() {} }), onChange: () => {} });
  await boards.refresh('p_1', PAGE);
  assert.match(boards.get('p_1', PAGE)!.error!, /Connectors gateway/);
});

test('no gateway: the brief says nothing about a board the agent cannot read or move', async () => {
  const home = tmpDir();
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects });
  projects.start(h.runner);
  const boards = new TaskBoards({ home, log: nullLogger, setTimeout: () => ({ cancel() {} }), onChange: () => projects.boardChanged() });
  projects.useTaskBoards(boards);
  const p = projects.create({ title: 'Port Geo', by: 'mike' });
  projects.update(p.id, { notion: PAGE });
  await boards.refresh(p.id, PAGE);
  const t = (await h.runner.create({ text: 'hi', cwd: home, accountId: 'claude-3' })).thread;
  projects.changeMembership(t.id, { add: [p.id], by: 'agent' });
  const brief = projects.brief(h.runner.threadRecords().find((x) => x.id === t.id)!) ?? '';
  assert.match(brief, /Port Geo/);
  assert.doesNotMatch(brief, /Tasks:/);
});

test("the gateway client comes from the main login's connectors entry; runner.json can name another helper", () => {
  const dir = tmpDir();
  const cj = path.join(dir, 'claude.json');
  fs.writeFileSync(cj, JSON.stringify({ mcpServers: { connectors: { type: 'http', url: 'https://bruce:8443/mcp', headersHelper: '/x/headers.sh claude-main' } } }));
  assert.deepEqual(findGatewayClient(undefined, cj), { mcpUrl: 'https://bruce:8443/mcp', headersHelper: '/x/headers.sh claude-main' });
  assert.deepEqual(findGatewayClient({ headersHelper: '/y/h.sh threadbear' }, cj), { mcpUrl: 'https://bruce:8443/mcp', headersHelper: '/y/h.sh threadbear' });
  assert.equal(findGatewayClient({ enabled: false }, cj), undefined);
  assert.equal(findGatewayClient(undefined, path.join(dir, 'none.json')), undefined);
});

// Daybreak, 7 Nov: the Notion reader sends the gateway's token with every
// call (src/secure-url.ts).
test('the gateway client is refused for a cleartext URL, from runner.json or the main login', () => {
  const dir = tmpDir();
  const cj = path.join(dir, 'claude.json');
  for (const bad of ['http://bruce.tail9ef766.ts.net:8443/mcp', 'http://127.0.0.1.evil.example/mcp', 'http://127.0.0.1@evil.example/mcp']) {
    fs.writeFileSync(cj, JSON.stringify({ mcpServers: { connectors: { type: 'http', url: bad, headersHelper: '/x/h.sh' } } }));
    assert.equal(findGatewayClient(undefined, cj), undefined, bad);
    fs.writeFileSync(cj, JSON.stringify({ mcpServers: { connectors: { type: 'http', url: 'https://bruce:8443/mcp', headersHelper: '/x/h.sh' } } }));
    assert.equal(findGatewayClient({ url: bad }, cj), undefined, bad);
  }
  assert.deepEqual(findGatewayClient({ url: 'http://127.0.0.1:9' }, cj), { mcpUrl: 'http://127.0.0.1:9/mcp', headersHelper: '/x/h.sh' });
});

test("the gateway caller never follows a redirect with the token, and won't send it in the clear", async () => {
  const headers = async () => ({ Authorization: 'Bearer secret-token' });
  const down = downgradeFetch('https://bruce:8443/mcp');
  await assert.rejects(gatewayCaller({ mcpUrl: 'https://bruce:8443/mcp', headers, fetch: down.fetch })('notion__notion-fetch', { id: 'x' }));
  assert.equal(down.inits[0]!.redirect, 'error');
  assert.deepEqual(down.leaked, []);
  // Real fetch, a 307 to another origin on this Mac.
  const t = await redirectTrap();
  try {
    await assert.rejects(gatewayCaller({ mcpUrl: `${t.url}/mcp`, headers })('notion__notion-fetch', { id: 'x' }));
    assert.deepEqual(t.hits, []);
  } finally {
    await t.close();
  }
  let fetched = 0;
  const fake = (async () => {
    fetched++;
    return new Response('{}');
  }) as unknown as typeof fetch;
  await assert.rejects(gatewayCaller({ mcpUrl: 'http://bruce:8443/mcp', headers, fetch: fake })('notion__notion-fetch', { id: 'x' }), /plain http/);
  assert.equal(fetched, 0);
});

test('a Notion page address: notion.so, notion.site or app.notion.com, or a data source; empty clears', () => {
  assert.equal(checkNotion(PAGE + '?pvs=204'), PAGE);
  assert.equal(checkNotion('https://www.notion.so/Tasks-94471028e3bb4e2a810d117d5b8f19fd'), 'https://www.notion.so/Tasks-94471028e3bb4e2a810d117d5b8f19fd');
  assert.equal(checkNotion(DS), DS);
  assert.equal(checkNotion('  '), '');
  assert.throws(() => checkNotion('https://example.com/p/1'), RpcError);
  assert.throws(() => checkNotion('notion'), RpcError);
});

test("a project with a Notion page sends its board; read_project lists the open cards; the brief says there's a board", async () => {
  const home = tmpDir();
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects });
  projects.start(h.runner);
  const n = fakeNotion();
  const boards = new TaskBoards({ home, call: n.call, log: nullLogger, setTimeout: () => ({ cancel() {} }), onChange: () => projects.boardChanged() });
  projects.useTaskBoards(boards);
  const methods = projectMethods(projects);
  const { project: p } = methods['projects.create']!({ title: 'Port Geo' }) as { project: { id: string } };
  await assert.rejects(Promise.resolve().then(() => methods['projects.refreshTasks']!({ projectId: p.id })), /no Notion page/);
  methods['projects.update']!({ projectId: p.id, notion: PAGE });
  const { project } = (await methods['projects.refreshTasks']!({ projectId: p.id })) as { project: { notion?: string; tasks?: { items: unknown[] } } };
  assert.equal(project.notion, PAGE);
  assert.equal(project.tasks?.items.length, 3);
  assert.ok(h.notes.some((x) => x.method === 'projects.updated' && (x.params as { projects: { tasks?: { items: unknown[] } }[] }).projects.some((q) => q.tasks?.items.length === 3)));

  // The agent's view.
  const t = (await h.runner.create({ text: 'hi', cwd: home, accountId: 'claude-3' })).thread;
  projects.changeMembership(t.id, { add: [p.id], by: 'agent' });
  const tools = buildThreadbearTools(h.runner, t.id, Date.now, undefined, projects);
  const read = tools.find((x) => x.name === 'read_project')!;
  const out = ((await read.handler({ project: p.id } as never, {} as never)) as { content: { text: string }[] }).content[0]!.text;
  assert.match(out, /Tasks \(Notion board https:\/\/app\.notion\.com\/p\/94471028e3bb4e2a810d117d5b8f19fd\):/);
  assert.match(out, /- Waiting:\n {2}- Eventbrite link for the tickets page \(Zaran\)/);
  assert.match(out, /Fixes from the 30 Oct reply \(Mike\), thread 60f772ab/);
  assert.match(projects.brief(h.runner.threadRecords().find((x) => x.id === t.id)!)!, /Tasks: a board in Notion \(https:\/\/app\.notion\.com\/p\/94471028e3bb4e2a810d117d5b8f19fd\), 3 open\./);

  // Taking the page off drops the board.
  methods['projects.update']!({ projectId: p.id, notion: '' });
  assert.equal((methods['projects.get']!({ projectId: p.id }) as { project: { tasks?: unknown; notion?: string } }).project.tasks, undefined);
  projects.stop();
});

test('boards are read a few at a time, so a big round never floods the gateway', async () => {
  let running = 0;
  let most = 0;
  const n = fakeNotion();
  const call: CallTool = async (name, args) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    return n.call(name, args);
  };
  const boards = new TaskBoards({ home: tmpDir(), call, log: nullLogger, setTimeout: () => ({ cancel() {} }), onChange: () => {} });
  await Promise.all(Array.from({ length: 12 }, (_, i) => boards.refresh(`p_${i}`, PAGE)));
  assert.ok(most <= READS_AT_ONCE, `at most ${READS_AT_ONCE} reads at once, saw ${most}`);
  for (let i = 0; i < 12; i++) assert.equal(boards.get(`p_${i}`, PAGE)!.items.length, 3);
});
