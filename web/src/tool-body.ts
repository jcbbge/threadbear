// What opening a tool line shows (messages.tsx ToolBody), from phone:eventBody.
// Pure, so it can be tested without a page.

export type DiffFile = { path: string; hunks: { lines?: string[] }[] };

// What a tool was given, as lines. A command as it would be typed; anything else
// as "key: value", as the Mac draws it.
export function inputLines(input: string | undefined): string[] {
  if (!input) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const o = parsed as Record<string, unknown>;
  if (typeof o.command === 'string') return [`$ ${o.command}`];
  return Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}

export function diffFiles(diffs: string | undefined): DiffFile[] {
  if (!diffs) return [];
  try {
    const parsed = JSON.parse(diffs);
    if (!Array.isArray(parsed)) return [];
    // What another machine sent: only the shapes this can draw.
    return parsed
      .filter((d) => typeof d?.path === 'string')
      .map((d) => ({ path: d.path as string, hunks: (Array.isArray(d.hunks) ? d.hunks : []).filter((h: unknown) => h && typeof h === 'object').map((h: { lines?: unknown }) => ({ lines: Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : [] })) }));
  } catch {
    return [];
  }
}

// How many picture buttons to draw, however many it says.
export function pictureCount(images: unknown): number {
  return Number.isInteger(images) && (images as number) > 0 ? Math.min(images as number, 20) : 0;
}

// Words for a tool whose output isn't here.
export function keptWords(state: 'withheld' | 'expired' | null): string {
  if (state === 'withheld') return 'Kept on the runner: what this tool read or ran can hold secrets, so its output stays there.';
  if (state === 'expired') return 'Kept on the runner: its copy here has expired.';
  return 'Kept on the runner.';
}
