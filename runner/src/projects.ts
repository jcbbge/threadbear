// Projects: a grouping above folders (docs/protocol.md, "Projects"). A
// project can have several folders, a thread can be in several projects,
// and each keeps goals, state and notes that carry forward from thread to
// thread. Nobody has to make them: the librarian (librarian.ts) and the
// agents (threadbear-mcp.ts) do, and Mike can fix anything by hand.
//
// The projects themselves are kept in projects.json in the data dir; which
// projects a thread is in is kept on the thread's record (store.ts), so it
// goes with the thread when it's deleted. A project is also the unit
// patches load by: a thread gets the patches of every folder of every
// project it's in (patches.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import type { Notification } from './runner.ts';
import type { Project, ProjectIcon, ProjectLink, ProjectMaker, ThreadProject, ThreadSummary } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import type { ThreadRecord } from './store.ts';
import type { ProjectFolder } from './patches.ts';
import { atomicWriteFileSync, isDirectory, readJsonSync } from './fsutil.ts';
import { expandHome } from './config.ts';
import { fileHash, removeIcons, storeIcon } from './project-icons.ts';
import { trimEndOf } from './linear-text.ts';
import type { TaskBoards } from './notion-tasks.ts';

// What projects.json holds for each: the counts are worked out from the
// threads when they're sent. An icon keeps the hash of the file it was
// copied from, to tell when that file changes.
export type ProjectRecord = Omit<Project, 'threadCount' | 'lastActivityAt' | 'icon' | 'tasks'> & { icon?: StoredIcon };
export type StoredIcon = ProjectIcon & { hash?: string };

// What Mike or an agent chooses: a picture, a symbol, or neither to go
// back to the one the librarian finds.
export type IconChoice = { path?: string; symbol?: string };

// What the projects need from the runner: its threads, a way to change
// one (which saves it, sends its summary and says what changed), and the
// clients.
export type ProjectHost = {
  threadRecords(): ThreadRecord[];
  // Changes a thread's record, then saves it and sends its summary. `note`
  // goes in the transcript.
  editThread(threadId: string, edit: (rec: ThreadRecord) => void, say?: { note?: string }): ThreadSummary;
  // Sends these threads' summaries again (a title changed) and reads their
  // patches again (folders changed).
  touchThreads(threadIds: string[]): void;
  resolveThread(idOrPrefix: string): string;
  publish(n: Notification): void;
  onNotification(fn: (n: Notification) => void): () => void;
};

// A link as agents and Mike give it: the title can be left to the host.
export type LinkInput = { title?: string; url: string };

export type CreateProjectParams = {
  title: string;
  folders?: string[];
  goals?: string;
  state?: string;
  notes?: string;
  links?: LinkInput[];
  threadIds?: string[];
  by: ProjectMaker;
  byThread?: string;
};

export type UpdateProjectParams = {
  title?: string;
  folders?: string[];
  goals?: string;
  state?: string;
  notes?: string;
  links?: LinkInput[];
  // A Notion page or database with the project's tasks; empty takes it off.
  notion?: string;
  archived?: boolean;
  // Who's changing the title, kept as titleBy. Absent counts as Mike, so a
  // name from somewhere unknown is never renamed by the librarian.
  by?: ProjectMaker;
};

export type MembershipChange = {
  add?: string[];
  remove?: string[];
  by: ProjectMaker;
  // Why it's in each added project, by project id (ThreadProject.why).
  why?: Record<string, string>;
};

// A reason is one line under a project's name; the librarian is asked for
// a dozen words, this only stops a runaway one.
export const WHY_MAX = 200;

const TITLE_MAX = 80;
const SHORT_MAX = 2000; // goals and state
const NOTES_MAX = 50_000;
// Past this, the librarian rewrites the notes shorter (librarian.ts,
// keepNotes). Agents appended a changelog of everything that landed until
// Threadbear's hit NOTES_MAX and a note was refused (Mike, 30 Oct); git
// and the docs already say what landed, and read_project hands an agent
// all of it.
export const NOTES_LONG = 12_000;
// A project's links are the few places Mike goes for it, not a bookmark
// list: more than this and the top of Highlights is all links.
export const LINKS_MAX = 8;
// How much of the projects goes into a session's brief, all of them together.
export const BRIEF_MAX = 2000;

export class Projects {
  private file: string;
  // Where projects' icons are copied to (project-icons.ts).
  readonly iconDir: string;
  private clock: Clock;
  private log: Logger;
  private home: string;
  private items = new Map<string, ProjectRecord>();
  private host?: ProjectHost;
  private unlisten?: () => void;
  // Set on a draining runner (handover): the primary owns projects.json now.
  private frozen = false;
  // Each project's task board from Notion (notion-tasks.ts), when the
  // runner reads them.
  private boards?: TaskBoards;

  constructor(deps: { home: string; clock: Clock; log: Logger; userHome?: string }) {
    this.file = path.join(deps.home, 'projects.json');
    this.iconDir = path.join(deps.home, 'project-icons');
    this.clock = deps.clock;
    this.log = deps.log;
    this.home = deps.userHome ?? os.homedir();
  }

  // Reads projects.json and starts listening to the runner. Called once the
  // runner's threads are loaded.
  start(host: ProjectHost): void {
    this.host = host;
    const saved = readJsonSync<{ projects?: ProjectRecord[] }>(this.file);
    if (!saved && fs.existsSync(this.file)) this.log.error('projects.json could not be read; starting with none', { file: this.file });
    for (const p of saved?.projects ?? []) {
      if (p && typeof p.id === 'string' && typeof p.title === 'string') this.items.set(p.id, { ...p, folders: p.folders ?? [], goals: p.goals ?? '', state: p.state ?? '', notes: p.notes ?? '', links: p.links ?? [] });
    }
    // A deleted thread changes its projects' counts.
    this.unlisten = host.onNotification((n) => {
      if (n.method === 'thread.deleted') this.publish();
    });
    this.log.info('projects loaded', { count: this.items.size });
  }

  stop(): void {
    this.unlisten?.();
    this.boards?.stop();
  }

  // Starts reading the task boards of projects with a Notion page. A board
  // that changes is sent with the projects.
  useTaskBoards(boards: TaskBoards): void {
    this.boards = boards;
    boards.start(() => [...this.items.values()].filter((p) => !p.archived).map((p) => ({ id: p.id, notion: p.notion })));
  }

  // Called by the boards when one changes.
  boardChanged(): void {
    this.publish();
  }

  // Reads a project's board again now (the project page asks when it
  // opens; force when Mike asks), then gives the project back.
  async refreshTasks(projectId: string, force = false): Promise<Project> {
    const rec = this.must(projectId);
    if (!rec.notion) throw bad(`${rec.title} has no Notion page. Set one with notion.`);
    await this.boards?.refresh(rec.id, rec.notion, force);
    return this.withCounts(this.must(rec.id), this.host?.threadRecords() ?? []);
  }

  // A draining runner reads projects for its kept threads but no longer
  // changes them.
  freeze(): void {
    this.frozen = true;
    // The primary reads the boards now.
    this.boards?.stop();
  }

  // A draining runner's copy of the primary's project, so a thread it keeps
  // can join one made or renamed since the handover (projectRouter in
  // handover.ts). Never saved: projects.json is the primary's.
  adopt(rec: ProjectRecord): void {
    if (this.frozen) this.items.set(rec.id, rec);
  }

  // ---------------------------------------------------------------- reads

  list(opts: { archived?: boolean } = {}): Project[] {
    const threads = this.host?.threadRecords() ?? [];
    return [...this.items.values()]
      .filter((p) => opts.archived || !p.archived)
      .map((p) => this.withCounts(p, threads))
      .sort((a, b) => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt));
  }

  get(projectId: string): { project: Project; threadIds: string[] } {
    const p = this.must(projectId);
    const threads = this.host?.threadRecords() ?? [];
    const threadIds = threads
      .filter((t) => t.projects?.some((m) => m.id === p.id))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((t) => t.id);
    return { project: this.withCounts(p, threads), threadIds };
  }

  // A project by id, unique id prefix or title (any case), for agents and
  // tb, who may name one either way.
  find(q: string): ProjectRecord | undefined {
    const want = q.trim();
    if (!want) return undefined;
    const exact = this.items.get(want);
    if (exact) return exact;
    const all = [...this.items.values()];
    const byPrefix = all.filter((p) => p.id.startsWith(want));
    if (byPrefix.length === 1) return byPrefix[0];
    const byTitle = all.filter((p) => p.title.toLowerCase() === want.toLowerCase());
    if (byTitle.length === 1) return byTitle[0];
    return undefined;
  }

  record(projectId: string): ProjectRecord | undefined {
    return this.items.get(projectId);
  }

  // The thread's projects as its summary shows them.
  threadProjects(rec: ThreadRecord): ThreadProject[] | undefined {
    const out: ThreadProject[] = [];
    for (const m of rec.projects ?? []) {
      const p = this.items.get(m.id);
      if (p) out.push({ ...m, title: p.title });
    }
    return out.length ? out : undefined;
  }

  // The folders the thread's patches load from, besides its own.
  foldersFor(rec: ThreadRecord): ProjectFolder[] {
    const out: ProjectFolder[] = [];
    for (const m of rec.projects ?? []) {
      const p = this.items.get(m.id);
      if (!p || p.archived) continue;
      for (const folder of p.folders) out.push({ folder, projectId: p.id });
    }
    return out;
  }

  // The folders projects.json lists, read before start(): the runner's
  // first start with patch trust trusts what they were already running.
  static savedFolders(home: string): string[] {
    const saved = readJsonSync<{ projects?: Partial<ProjectRecord>[] }>(path.join(home, 'projects.json'));
    return (saved?.projects ?? []).flatMap((p) => (Array.isArray(p?.folders) ? p.folders.filter((f): f is string => typeof f === 'string') : []));
  }

  // Every folder of every project that isn't archived, each once: where
  // tool patches (appliesTo) are looked for, for any thread.
  allFolders(): string[] {
    const out = new Set<string>();
    for (const p of this.items.values()) if (!p.archived) for (const folder of p.folders) out.add(folder);
    return [...out];
  }

  // What a session starting on the thread is told about its projects
  // (docs/protocol.md, "The brief"), or undefined when it's in none.
  brief(rec: ThreadRecord): string | undefined {
    const projects = (rec.projects ?? []).map((m) => this.items.get(m.id)).filter((p): p is ProjectRecord => Boolean(p && !p.archived));
    if (!projects.length) return undefined;
    // Each project gets an even share; long goals and state are cut.
    const share = Math.floor(BRIEF_MAX / projects.length);
    const blocks = projects.map((p) => this.briefBlock(p, share));
    return (
      '[Threadbear projects] This thread is part of the projects below. A project outlasts any one thread: ' +
      'when you learn something that should carry on (a decision, where things are up to, what is next, a gotcha), ' +
      'update it with the threadbear tool update_project. read_project has each one\'s notes.\n\n' +
      blocks.join('\n\n')
    );
  }

  private briefBlock(p: ProjectRecord, max: number): string {
    const head = `## ${p.title} (${p.id})` + (p.folders.length ? `\nFolders: ${p.folders.map((f) => this.tilde(f)).join(', ')}` : '');
    const room = Math.max(120, max - head.length - 20);
    const goals = clip(p.goals, Math.floor(room / 2));
    const state = clip(p.state, room - goals.length);
    return [head, goals && `Goals: ${goals}`, state && `State: ${state}`, this.tasksLine(p)].filter(Boolean).join('\n');
  }

  // One line on the project's Notion board for the brief, so an agent
  // knows to keep it moving: how many cards are open, and where.
  private tasksLine(p: ProjectRecord): string | undefined {
    const t = p.notion ? this.boards?.get(p.id, p.notion) : undefined;
    // A board that has never read (no Connectors gateway, say) has nothing
    // to keep moving, and the agent may have no Notion tools to move it with.
    if (!t || t.loading || (t.error && t.columns.length === 0 && t.items.length === 0)) return undefined;
    const open = t.items.filter((i) => t.columns.find((c) => c.name === i.status)?.kind !== 'done').length;
    return `Tasks: a board in Notion (${t.url}), ${open} open. read_project lists them; move a card with the Notion tools when its work starts, stalls or is done.`;
  }

  // The projects a brief covers, for knowing what a session has been told.
  briefIds(rec: ThreadRecord): string[] {
    return (rec.projects ?? []).map((m) => m.id).filter((id) => this.items.get(id) && !this.items.get(id)!.archived);
  }

  // Lines for a session told about these projects since it started.
  joinedLines(ids: string[]): string | undefined {
    const lines = ids.map((id) => this.items.get(id)).filter((p): p is ProjectRecord => Boolean(p)).map((p) => this.joinedLine(p));
    return lines.length ? lines.join('\n') : undefined;
  }

  // A line for the agent when its thread joins a project mid-session.
  joinedLine(p: ProjectRecord): string {
    const bits = [`[Threadbear project] This thread is now part of the project "${p.title}" (${p.id}).`];
    if (p.goals) bits.push(`Goals: ${clip(p.goals, 300)}`);
    if (p.state) bits.push(`State: ${clip(p.state, 300)}`);
    bits.push('read_project has its notes; update_project keeps it current.');
    return bits.join(' ');
  }

  // ---------------------------------------------------------------- writes

  create(params: CreateProjectParams): Project {
    const title = checkTitle(params.title);
    const now = this.iso();
    const rec: ProjectRecord = {
      id: this.newId(),
      title,
      folders: this.checkFolders(params.folders ?? []),
      goals: checkText('goals', params.goals ?? '', SHORT_MAX),
      state: checkText('state', params.state ?? '', SHORT_MAX),
      notes: checkText('notes', params.notes ?? '', NOTES_MAX),
      links: checkLinks(params.links ?? []),
      createdBy: params.by,
      titleBy: params.by,
      createdAt: now,
      updatedAt: now,
    };
    if (params.byThread) rec.createdByThread = params.byThread;
    if (rec.state) rec.stateUpdatedAt = now;
    // Every thread named must exist before anything changes.
    const threadIds = (params.threadIds ?? []).map((t) => this.mustHost().resolveThread(t));
    this.items.set(rec.id, rec);
    this.save();
    this.log.info('project made', { id: rec.id, title: rec.title, by: params.by });
    for (const t of threadIds) this.changeMembership(t, { add: [rec.id], by: params.by });
    this.publish();
    return this.withCounts(rec, this.mustHost().threadRecords());
  }

  update(projectId: string, params: UpdateProjectParams): Project {
    const rec = this.must(projectId);
    const next = { ...rec };
    if (params.title !== undefined) next.title = checkTitle(params.title);
    if (next.title !== rec.title) next.titleBy = params.by ?? 'mike';
    if (params.folders !== undefined) next.folders = this.checkFolders(params.folders, rec.folders);
    if (params.goals !== undefined) next.goals = checkText('goals', params.goals, SHORT_MAX);
    if (params.state !== undefined) next.state = checkText('state', params.state, SHORT_MAX);
    if (params.notes !== undefined) next.notes = checkText('notes', params.notes, NOTES_MAX);
    if (params.links !== undefined) next.links = checkLinks(params.links);
    if (params.notion !== undefined) {
      const n = checkNotion(params.notion);
      if (n) next.notion = n;
      else delete next.notion;
    }
    if (params.archived !== undefined) {
      if (params.archived) next.archived = true;
      else delete next.archived;
    }
    const now = this.iso();
    if (params.state !== undefined && next.state !== rec.state) next.stateUpdatedAt = now;
    next.updatedAt = now;
    this.items.set(rec.id, next);
    this.save();
    // Its threads' summaries carry its title, and their patches its folders.
    if (next.title !== rec.title || JSON.stringify(next.folders) !== JSON.stringify(rec.folders) || next.archived !== rec.archived) {
      this.mustHost().touchThreads(this.threadsIn(rec.id));
    }
    if (next.notion !== rec.notion) void this.boards?.refresh(rec.id, next.notion, true).catch(() => {});
    this.publish();
    return this.withCounts(next, this.mustHost().threadRecords());
  }

  // Adds a paragraph to the notes rather than replacing them, for agents
  // that only want to say one thing.
  appendNote(projectId: string, text: string): Project {
    const rec = this.must(projectId);
    const add = text.trim();
    if (!add) throw bad('The note is empty.');
    if (rec.notes.length + add.length + 2 > NOTES_MAX) {
      throw bad(`The notes are full (${rec.notes.length} of ${NOTES_MAX} characters). Rewrite them shorter with notes, keeping decisions, gotchas and what's still owed and dropping what git and the docs already record, then add this.`);
    }
    return this.update(projectId, { notes: rec.notes.trim() ? `${rec.notes.trimEnd()}\n\n${add}` : add });
  }

  // Adds links, or retitles ones it already has (same url), keeping the
  // rest. For agents and the librarian, which add one at a time.
  addLinks(projectId: string, links: LinkInput[]): Project {
    const rec = this.must(projectId);
    const add = checkLinks(links);
    const next = rec.links.map((l) => add.find((a) => sameUrl(a.url, l.url)) ?? l);
    for (const l of add) if (!next.some((n) => sameUrl(n.url, l.url))) next.push(l);
    return this.update(projectId, { links: next });
  }

  removeLinks(projectId: string, urls: string[]): Project {
    const rec = this.must(projectId);
    return this.update(projectId, { links: rec.links.filter((l) => !urls.some((u) => sameUrl(u, l.url))) });
  }

  merge(projectId: string, intoId: string): Project {
    const from = this.must(projectId);
    const into = this.must(intoId);
    if (from.id === into.id) throw bad("A project can't be merged into itself.");
    const now = this.iso();
    const kept: ProjectRecord = {
      ...into,
      folders: [...into.folders, ...from.folders.filter((f) => !into.folders.includes(f))],
      goals: into.goals || from.goals,
      state: into.state || from.state,
      notes: [into.notes.trim(), from.notes.trim() && `## From ${from.title}\n\n${from.notes.trim()}`].filter(Boolean).join('\n\n'),
      links: [...into.links, ...from.links.filter((l) => !into.links.some((i) => sameUrl(i.url, l.url)))].slice(0, LINKS_MAX),
      updatedAt: now,
    };
    this.items.set(into.id, kept);
    this.items.delete(from.id);
    this.save();
    // The kept project's icon stays; with none, the librarian finds one.
    removeIcons(this.iconDir, from.id);
    for (const t of this.mustHost().threadRecords()) {
      if (!t.projects?.some((m) => m.id === from.id)) continue;
      this.mustHost().editThread(t.id, (r) => {
        const had = r.projects!.find((m) => m.id === from.id)!;
        r.projects = r.projects!.filter((m) => m.id !== from.id);
        if (!r.projects.some((m) => m.id === into.id)) r.projects.push({ ...had, id: into.id });
        if (r.projectsLeft?.includes(from.id)) r.projectsLeft = r.projectsLeft.filter((x) => x !== from.id);
      });
    }
    this.mustHost().touchThreads(this.threadsIn(into.id));
    this.log.info('projects merged', { from: from.id, into: into.id });
    this.publish();
    return this.withCounts(kept, this.mustHost().threadRecords());
  }

  delete(projectId: string): Record<string, never> {
    const rec = this.must(projectId);
    for (const t of this.threadsIn(rec.id)) {
      this.mustHost().editThread(t, (r) => {
        r.projects = (r.projects ?? []).filter((m) => m.id !== rec.id);
        if (!r.projects.length) delete r.projects;
      });
    }
    // Forgotten everywhere, so "never put back" doesn't outlive it.
    for (const t of this.mustHost().threadRecords()) {
      if (t.projectsLeft?.includes(rec.id)) {
        this.mustHost().editThread(t.id, (r) => {
          r.projectsLeft = r.projectsLeft!.filter((x) => x !== rec.id);
          if (!r.projectsLeft.length) delete r.projectsLeft;
        });
      }
    }
    this.items.delete(rec.id);
    this.save();
    removeIcons(this.iconDir, rec.id);
    this.log.info('project deleted', { id: rec.id, title: rec.title });
    this.publish();
    return {};
  }

  // Puts a thread in projects and takes it out of others. Mike's and
  // agents' changes are pinned (added) or remembered (removed), so the
  // librarian never undoes them; the librarian only adds where nobody has
  // taken the thread out, and only takes out what it put there itself.
  // Returns the projects that actually changed.
  changeMembership(threadId: string, change: MembershipChange): { joined: string[]; left: string[]; thread: ThreadSummary } {
    const host = this.mustHost();
    const id = host.resolveThread(threadId);
    const add = (change.add ?? []).map((p) => this.must(p).id);
    const remove = (change.remove ?? []).map((p) => this.must(p).id);
    const rec = host.threadRecords().find((t) => t.id === id)!;
    const joined: string[] = [];
    const left: string[] = [];
    const at = this.iso();
    const current = new Map((rec.projects ?? []).map((m) => [m.id, m]));
    const plan: ((r: ThreadRecord) => void)[] = [];
    const whyFor = (p: string) => {
      const w = change.why?.[p]?.trim().replace(/\s+/g, ' ').slice(0, WHY_MAX);
      return w ? { why: w } : {};
    };
    for (const p of add) {
      const has = current.get(p);
      if (change.by === 'librarian') {
        // Its own guess, looked at again: the newer reason replaces the
        // old, so the line under the project says what it thinks now.
        const why = whyFor(p).why;
        if (has && has.by === 'librarian' && why && why !== has.why) plan.push((r) => (r.projects!.find((m) => m.id === p)!.why = why));
        if (has || rec.projectsLeft?.includes(p)) continue;
      } else if (has) {
        // Already there: Mike or an agent saying so pins it.
        if (!has.pinned) plan.push((r) => (r.projects!.find((m) => m.id === p)!.pinned = true));
        continue;
      }
      joined.push(p);
      plan.push((r) => {
        (r.projects ??= []).push({ id: p, by: change.by, at, ...(change.by === 'librarian' ? {} : { pinned: true }), ...whyFor(p) });
        if (r.projectsLeft?.includes(p)) {
          r.projectsLeft = r.projectsLeft.filter((x) => x !== p);
          if (!r.projectsLeft.length) delete r.projectsLeft;
        }
      });
    }
    for (const p of remove) {
      const has = current.get(p);
      if (!has) continue;
      if (change.by === 'librarian' && (has.pinned || has.by !== 'librarian')) continue;
      left.push(p);
      plan.push((r) => {
        r.projects = (r.projects ?? []).filter((m) => m.id !== p);
        if (!r.projects.length) delete r.projects;
        if (change.by !== 'librarian' && !r.projectsLeft?.includes(p)) (r.projectsLeft ??= []).push(p);
      });
    }
    if (!plan.length) return { joined, left, thread: host.editThread(id, () => {}) };
    const names = (ids: string[]) => ids.map((p) => this.items.get(p)!.title).join(' and ');
    const say: { note?: string } = {};
    // Mike sees his own change; the librarian's and agents' are said in
    // the transcript so a wrong guess gets noticed.
    if (change.by !== 'mike' && (joined.length || left.length)) {
      const who = change.by === 'librarian' ? 'by the librarian' : 'by the agent';
      const parts = [joined.length ? `Put in ${names(joined)}` : '', left.length ? `Taken out of ${names(left)}` : ''].filter(Boolean);
      say.note = `${parts.join('. ')} ${who}.`;
    }
    // An agent that joined one itself knows: don't tell it again.
    if (change.by === 'agent' && joined.length) plan.push((r) => (r.projectsTold = [...new Set([...(r.projectsTold ?? []), ...joined])]));
    const thread = host.editThread(id, (r) => plan.forEach((f) => f(r)), say);
    this.log.info('thread projects changed', { threadId: id, by: change.by, joined, left });
    this.publish();
    return { joined, left, thread };
  }

  // The librarian's icon, found or picked (librarian.ts). Never over one
  // Mike or an agent chose: they set it back to automatic first.
  setFoundIcon(projectId: string, icon: Omit<StoredIcon, 'by' | 'updatedAt'>): Project | undefined {
    const rec = this.items.get(projectId);
    if (!rec || (rec.icon && rec.icon.by !== 'librarian')) return undefined;
    return this.putIcon(rec, { ...icon, by: 'librarian', updatedAt: this.iso() });
  }

  // Mike's or an agent's choice: a picture file (copied in), an SF Symbol,
  // or neither for automatic again, which the librarian fills in soon.
  async chooseIcon(projectId: string, choice: IconChoice, by: ProjectMaker): Promise<Project> {
    const rec = this.must(projectId);
    if (this.frozen) throw new RpcError(ErrorCode.other, 'This runner is handing over; projects are changed on the new one.');
    if (choice.path !== undefined && choice.symbol !== undefined) throw bad('Give a picture or a symbol, not both.');
    if (choice.path !== undefined) {
      const src = path.resolve(expandHome(choice.path.trim()));
      if (!/\.(png|jpe?g|webp|svg|icns|ico|gif|heic|tiff?)$/i.test(src)) throw bad('An icon is a picture: PNG, JPEG, WebP, SVG, ICNS or ICO.');
      const hash = await fileHash(src);
      if (!hash) throw bad(`Picture not found (or over 10 MB): ${src}`);
      const image = await storeIcon(src, this.iconDir, rec.id, hash);
      return this.putIcon(this.must(rec.id), { image, from: src, hash, by, updatedAt: this.iso() });
    }
    if (choice.symbol !== undefined) {
      const symbol = choice.symbol.trim();
      if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(symbol) || symbol.length > 80) throw bad(`Not an SF Symbol name: ${choice.symbol}`);
      removeIcons(this.iconDir, rec.id);
      return this.putIcon(rec, { symbol, by, updatedAt: this.iso() });
    }
    removeIcons(this.iconDir, rec.id);
    return this.putIcon(rec, undefined);
  }

  private putIcon(rec: ProjectRecord, icon: StoredIcon | undefined): Project {
    const next = { ...rec };
    if (icon) next.icon = icon;
    else delete next.icon;
    this.items.set(rec.id, next);
    this.save();
    this.log.info('project icon', { id: rec.id, by: icon?.by, image: icon?.image?.path, symbol: icon?.symbol });
    this.publish();
    return this.withCounts(next, this.mustHost().threadRecords());
  }

  // ------------------------------------------------------------- helpers

  threadsIn(projectId: string): string[] {
    return (this.host?.threadRecords() ?? []).filter((t) => t.projects?.some((m) => m.id === projectId)).map((t) => t.id);
  }

  private withCounts(p: ProjectRecord, threads: ThreadRecord[]): Project {
    let count = 0;
    let last: string | undefined;
    for (const t of threads) {
      if (!t.projects?.some((m) => m.id === p.id)) continue;
      count++;
      if (!last || t.lastActivityAt > last) last = t.lastActivityAt;
    }
    const { icon, ...rest } = p;
    const out: Project = { ...rest, threadCount: count };
    if (icon) {
      const { hash: _hash, ...shown } = icon;
      out.icon = shown;
    }
    if (last) out.lastActivityAt = last;
    const tasks = this.boards?.get(p.id, p.notion);
    if (tasks) out.tasks = tasks;
    return out;
  }

  private must(projectId: string): ProjectRecord {
    const p = typeof projectId === 'string' ? this.items.get(projectId) ?? this.find(projectId) : undefined;
    if (!p) throw new RpcError(ErrorCode.projectNotFound, `No project called ${projectId}`);
    return p;
  }

  private mustHost(): ProjectHost {
    if (!this.host) throw new Error('Projects used before start()');
    return this.host;
  }

  // `kept`: the project's folders before this change. Only new ones must
  // exist: a repo deleted since it was added would otherwise refuse every
  // later folder change, the librarian's addFolders included (30 Oct, a
  // deleted ~/dev/me/quick-ask failed its looks).
  private checkFolders(folders: string[], kept: string[] = []): string[] {
    if (!Array.isArray(folders)) throw bad('folders must be a list of paths');
    const out: string[] = [];
    for (const f of folders) {
      if (typeof f !== 'string' || !f.trim()) throw bad('folders must be a list of paths');
      const dir = path.resolve(expandHome(f.trim()));
      if (!kept.includes(dir) && !isDirectory(dir)) throw bad(`Folder not found: ${dir}`);
      if (!out.includes(dir)) out.push(dir);
    }
    return out;
  }

  private newId(): string {
    for (;;) {
      const id = 'p_' + crypto.randomBytes(4).toString('hex');
      if (!this.items.has(id)) return id;
    }
  }

  private tilde(p: string): string {
    return p === this.home || p.startsWith(this.home + path.sep) ? '~' + p.slice(this.home.length) : p;
  }

  private save(): void {
    if (this.frozen) throw new RpcError(ErrorCode.other, 'This runner is handing over; projects are changed on the new one.');
    atomicWriteFileSync(this.file, JSON.stringify({ projects: [...this.items.values()] }, null, 2));
  }

  private publish(): void {
    this.host?.publish({ method: 'projects.updated', params: { projects: this.list({ archived: true }) } });
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

function checkTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) throw bad('A project needs a title.');
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.length > TITLE_MAX) throw bad(`A project title is at most ${TITLE_MAX} characters.`);
  return t;
}

// A Notion page or database: its notion.so, notion.site or app.notion.com
// address, or a collection:// data source. Empty means none.
export function checkNotion(v: unknown): string {
  if (typeof v !== 'string') throw bad('notion must be a Notion page address');
  const t = v.trim();
  if (!t) return '';
  if (/^collection:\/\/[0-9a-f-]{32,36}$/i.test(t)) return t;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw bad(`${t} isn't a Notion page address.`);
  }
  if (u.protocol !== 'https:' || !/(^|\.)(notion\.so|notion\.site|notion\.com)$/.test(u.hostname)) throw bad(`${t} isn't a Notion page address.`);
  u.searchParams.delete('pvs');
  return u.href;
}

function checkText(name: string, text: unknown, max: number): string {
  if (typeof text !== 'string') throw bad(`${name} must be text`);
  if (text.length > max) throw bad(`${name} is at most ${max} characters.`);
  return text.trim();
}

// Each a web address with a title (the host when there's none), no two the
// same, at most LINKS_MAX.
export function checkLinks(links: unknown): ProjectLink[] {
  if (!Array.isArray(links)) throw bad('links must be a list of { title, url }');
  const out: ProjectLink[] = [];
  for (const l of links) {
    if (!l || typeof l !== 'object') throw bad('links must be a list of { title, url }');
    const { title, url } = l as Record<string, unknown>;
    if (typeof url !== 'string') throw bad('A link needs a url.');
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw bad(`${url} isn't a web address.`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw bad(`${url} isn't a web address.`);
    if (title !== undefined && title !== null && typeof title !== 'string') throw bad('A link\'s title must be text.');
    const name = (typeof title === 'string' ? title.trim() : '') || parsed.host.replace(/^www\./, '');
    if (out.some((o) => sameUrl(o.url, parsed.href))) continue;
    out.push({ title: name.slice(0, TITLE_MAX), url: parsed.href });
  }
  if (out.length > LINKS_MAX) throw bad(`A project has at most ${LINKS_MAX} links: the few places the user goes for it.`);
  return out;
}

// The same page, give or take a trailing slash.
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => trimEndOf(u.trim(), '/').toLowerCase();
  return norm(a) === norm(b);
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : t;
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

// ------------------------------------------------------------- the methods

export function projectMethods(projects: Projects): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'projects.list': (p) => ({ projects: projects.list({ archived: bool(p, 'archived') }) }),
    'projects.get': (p) => projects.get(reqStr(p, 'projectId')),
    'projects.create': (p) => ({
      project: projects.create({
        title: reqStr(p, 'title'),
        folders: strList(p, 'folders'),
        goals: str(p, 'goals'),
        state: str(p, 'state'),
        notes: str(p, 'notes'),
        links: links(p),
        threadIds: strList(p, 'threadIds'),
        by: 'mike',
      }),
    }),
    'projects.update': (p) => ({
      project: projects.update(reqStr(p, 'projectId'), {
        title: str(p, 'title'),
        folders: strList(p, 'folders'),
        goals: str(p, 'goals'),
        state: str(p, 'state'),
        notes: str(p, 'notes'),
        links: links(p),
        notion: str(p, 'notion'),
        archived: bool(p, 'archived'),
        by: 'mike',
      }),
    }),
    'projects.refreshTasks': async (p) => ({ project: await projects.refreshTasks(reqStr(p, 'projectId'), bool(p, 'force')) }),
    'projects.setIcon': async (p) => {
      const path = str(p, 'path');
      const symbol = str(p, 'symbol');
      return { project: await projects.chooseIcon(reqStr(p, 'projectId'), { path, symbol }, 'mike') };
    },
    'projects.merge': (p) => ({ project: projects.merge(reqStr(p, 'projectId'), reqStr(p, 'intoId')) }),
    'projects.delete': (p) => projects.delete(reqStr(p, 'projectId')),
    'threads.setProjects': (p) => ({
      thread: projects.changeMembership(reqStr(p, 'threadId'), { add: strList(p, 'add'), remove: strList(p, 'remove'), by: 'mike' }).thread,
    }),
  };
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function links(p: Record<string, unknown>): ProjectLink[] | undefined {
  const v = p.links;
  return v === undefined || v === null ? undefined : checkLinks(v);
}

function reqStr(p: Record<string, unknown>, k: string): string {
  const v = str(p, k);
  if (v === undefined) throw bad(`${k} must be a string`);
  return v;
}

function strList(p: Record<string, unknown>, k: string): string[] | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad(`${k} must be a list of strings`);
  return v as string[];
}

function bool(p: Record<string, unknown>, k: string): boolean | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${k} must be a boolean`);
  return v;
}

// The Projects calls the agent tools make, which a draining runner's tools
// make on the primary instead (projectRouter in handover.ts).
export const DRAIN_PROJECT_OPS = ['list', 'get', 'find', 'create', 'update', 'appendNote', 'addLinks', 'removeLinks', 'changeMembership', 'chooseIcon'] as const;
export type DrainProjectOp = (typeof DRAIN_PROJECT_OPS)[number];

// drain.projects (docs/protocol.md, "Handovers"): a kept thread's project
// tool call, made here because projects.json is this runner's now. The
// arguments are the ones the tool built on the draining runner, maker
// included, so an agent's change still counts as the agent's.
export function drainProjectMethods(projects: Projects): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'drain.projects': async (p) => {
      const op = reqStr(p, 'op');
      if (!(DRAIN_PROJECT_OPS as readonly string[]).includes(op)) throw bad(`drain.projects has no ${op}`);
      if (!Array.isArray(p.args)) throw bad('args must be a list');
      const call = projects[op as DrainProjectOp] as (...args: unknown[]) => unknown;
      // find answers undefined for no such project, which JSON can't carry.
      return { result: (await call.apply(projects, p.args)) ?? null };
    },
  };
}
