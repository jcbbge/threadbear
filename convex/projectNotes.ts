// projectNotes: a project's notes, in a row of their own (schema.ts, API 50).
// A runner of API 50 or later sends a project's notes only when they change,
// so a state update or a new thread count rewrites the small `projects` row
// and leaves the notes alone. `projects.notes` stays '' for rows written
// since; an older row keeps its notes there until it's next written, and
// readers fall back to it meanwhile.
import type { MutationCtx, QueryCtx } from './_generated/server';

type Db = { db: MutationCtx['db'] };

function row(ctx: { db: QueryCtx['db'] }, runnerId: string, id: string) {
  return ctx.db.query('projectNotes').withIndex('by_runner_id', (q) => q.eq('runnerId', runnerId).eq('id', id)).unique();
}

// Only written when they differ; no notes, no row.
export async function putNotes(ctx: Db, runnerId: string, id: string, notes: string): Promise<void> {
  const existing = await row(ctx, runnerId, id);
  if (!notes) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (!existing) await ctx.db.insert('projectNotes', { runnerId, id, notes });
  else if (existing.notes !== notes) await ctx.db.replace(existing._id, { runnerId, id, notes });
}

export async function dropNotes(ctx: Db, runnerId: string, id: string): Promise<void> {
  const existing = await row(ctx, runnerId, id);
  if (existing) await ctx.db.delete(existing._id);
}

// A runner's whole list (setProjects): each project's notes as given, and
// the rows of projects that are gone, gone. One read of the runner's rows.
export async function syncNotes(ctx: Db, runnerId: string, projects: { id: string; notes: string }[]): Promise<void> {
  const have = new Map<string, { _id: any; notes: string }>();
  for await (const r of ctx.db.query('projectNotes').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
    // Two rows for one project can't happen through these functions, but
    // if they did, the extra one goes rather than shadowing the other.
    if (have.has(r.id)) await ctx.db.delete(r._id);
    else have.set(r.id, r);
  }
  const wanted = new Set<string>();
  for (const p of projects) {
    if (!p.notes) continue;
    wanted.add(p.id);
    const r = have.get(p.id);
    if (!r) await ctx.db.insert('projectNotes', { runnerId, id: p.id, notes: p.notes });
    else if (r.notes !== p.notes) await ctx.db.replace(r._id, { runnerId, id: p.id, notes: p.notes });
  }
  for (const [id, r] of have) if (!wanted.has(id)) await ctx.db.delete(r._id);
}

// The notes a reader shows: this table's, else what an older row still holds.
export async function notesOf(ctx: { db: QueryCtx['db'] }, p: { runnerId: string; id: string; notes: string }): Promise<string> {
  return (await row(ctx, p.runnerId, p.id))?.notes ?? p.notes;
}
