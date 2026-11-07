// What a finished turn needs from Mike (docs/protocol.md, "Needs you"):
// the agent's end_turn call, or failing that the "What I need from you"
// section his own instructions ask every agent to end with. No model call:
// the agent that did the work is the one that knows.

import type { Ask, AskLink, NeedsWho, PersistedEvent } from './protocol.ts';
import { hasLineBreak, replaceLinks } from './linear-text.ts';
import { cutSafely, safeEnd } from './safe-cut.ts';

export type Needs = { needs: NeedsWho; asks?: Ask[]; next?: string[] };

export const END_TURN_TOOL = 'end_turn';
// As the CLIs name it: under threadbear-mcp.ts's SERVER_NAME, which lives
// here too so the adapters needn't import the server.
export const END_TURN_FULL_NAME = `mcp__threadbear__${END_TURN_TOOL}`;

// Big enough for any real list; an agent that sends more is rambling.
const MAX_ASKS = 10;
const MAX_ACTION = 500;
const MAX_SHORT = 200;
// A decision with more than this many choices is better as a question.
const MAX_OPTIONS = 6;
// A button or two to go and do the thing; past three it's a reading list.
const MAX_LINKS = 3;
const MAX_URL = 2000;
// Follow-ups on the done card: a few buttons, each a short message.
const MAX_NEXT = 3;
const MAX_NEXT_CHARS = 120;
// Web pages, paths on this Mac, and review:<id>, which opens one of the
// thread's show_options reviews (Mike, 30 Oct: "Watch A" opened the video
// but nothing opened the stills to compare). Anything else (javascript:,
// other schemes) isn't something a button should open.
const LINK_URL = /^(?:https?:\/\/|file:\/\/|\/|~\/|review:[\w-]+$)/i;

// Which form of end_turn a call was written for, when it shows. A Codex
// thread's tool list is fixed when it starts, so its agent may have the form
// from before One reply changed, whatever the setting says now (docs/protocol.md).
// An ask's own field comes first: a call with both, as an agent writes when
// correcting itself, has its asks in that form.
export function endTurnForm(input: unknown): 'oneReply' | 'bullets' | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const asks: unknown[] = Array.isArray(o.asks) ? o.asks : [];
  const has = (key: string) => asks.some((a) => a !== null && typeof a === 'object' && key in a);
  if (has('question')) return 'oneReply';
  if (has('action') || has('why')) return 'bullets';
  if (o.summary !== undefined) return 'bullets';
  if (o.headline !== undefined) return 'oneReply';
  return undefined;
}

// end_turn's input, checked. Undefined when it isn't usable, so the turn
// falls back to the text.
export function needsFromTool(input: unknown): Needs | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  // Left out, it comes from the asks: agents filling in a summary forgot
  // it 2 times in 9 (29 Oct 2026). Anything else is a call to ignore.
  if (o.needs !== undefined && o.needs !== 'you' && o.needs !== 'nothing') return undefined;
  if (o.needs === 'nothing') return done(o.next);
  const asks: Ask[] = [];
  for (const a of Array.isArray(o.asks) ? o.asks : []) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    // One reply (docs/protocol.md, "One reply") asks a question and has no
    // why; the card shows it as the ask's paragraph, so it's the action.
    const action = clipText(r.action, MAX_ACTION) ?? clipText(r.question, MAX_ACTION);
    if (!action) continue;
    const ask: Ask = { action };
    const where = str(r.where, MAX_SHORT);
    if (where) ask.where = where;
    const reply = str(r.reply, MAX_SHORT);
    if (reply) ask.reply = reply;
    const why = clipText(r.why, MAX_ACTION);
    if (why) ask.why = why;
    // An answer is a label, or with one reply { label, does }: does says
    // what happens if Mike picks it, drawn under its label on the card.
    const answers = (Array.isArray(r.options) ? r.options : [])
      .map((o) => (o && typeof o === 'object' ? { label: str((o as Record<string, unknown>).label, MAX_SHORT), does: clipText((o as Record<string, unknown>).does, MAX_SHORT) } : { label: str(o, MAX_SHORT), does: undefined }))
      .filter((o): o is { label: string; does: string | undefined } => !!o.label)
      .slice(0, MAX_OPTIONS);
    const options = answers.map((o) => o.label);
    if (options.length) {
      ask.options = options;
      if (answers.some((o) => o.does)) ask.optionNotes = answers.map((o) => o.does ?? '');
      // Only an index that points at one of them; anything else is no pick.
      const s = r.suggested;
      if (typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < options.length) ask.suggested = s;
    }
    const links = linksFrom(r.links);
    if (links.length) ask.links = links;
    asks.push(ask);
    if (asks.length === MAX_ASKS) break;
  }
  if (o.needs === undefined) return asks.length ? { needs: 'you', asks } : done(o.next);
  return asks.length ? { needs: 'you', asks } : { needs: 'you' };
}

// A turn that needs nothing, with any follow-ups it suggested: the done
// card's buttons (docs/protocol.md, "Next steps"). Only here, as a card
// of asks already has its own buttons.
function done(v: unknown): Needs {
  const next = [...new Set((Array.isArray(v) ? v : []).map((n) => clipText(n, MAX_NEXT_CHARS)).filter((n): n is string => !!n))].slice(0, MAX_NEXT);
  return next.length ? { needs: 'nothing', next } : { needs: 'nothing' };
}

// Big enough for any turn's story; past this it's the working again.
const MAX_SUMMARY = 8;
const MAX_BULLET = 400;

// end_turn's summary bullets, tidied (docs/protocol.md, "The summary"),
// or undefined when there are none, so the turn's own text is its reply.
export function summaryFromTool(input: unknown): string[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>).summary;
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const b of v) {
    // The app draws them as a list, so a bullet of its own would be doubled.
    const t = typeof b === 'string' ? b.trim().replace(/^[-*•]\s+/, '').trim() : '';
    if (t) out.push(cutSafely(t, MAX_BULLET));
    if (out.length === MAX_SUMMARY) break;
  }
  return out.length ? out : undefined;
}

// The summary as the reply's text: a markdown list, one bullet a line.
export function summaryMarkdown(bullets: string[]): string {
  return bullets.map((b) => `- ${b}`).join('\n');
}

// Whether end_turn asked for its thread to be archived once the turn is
// over. Only with needs "nothing": a thread that's waiting on Mike has to
// stay where he'll see it.
export function archiveFromTool(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const o = input as Record<string, unknown>;
  return o.archive === true && needsFromTool(input)?.needs === 'nothing';
}

// When end_turn asked for its thread to hibernate once the turn is over:
// update_thread's times ("2h", "tomorrow", an ISO time, "restart"), or
// words like "when the phone arrives", read as Hibernate in words reads
// Mike's (wake-when.ts). Like archive, only with needs "nothing", as a
// hibernating thread would hide a card waiting on him. A thread can't
// snooze itself mid-turn, as that stops the CLI, so on 2 Nov 2026 "let's
// hibernate this thread until it arrives" took a helper thread.
export function snoozeFromTool(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const s = (input as Record<string, unknown>).snooze;
  if (typeof s !== 'string' || !s.trim() || s.trim().toLowerCase() === 'off') return undefined;
  return needsFromTool(input)?.needs === 'nothing' ? s.trim() : undefined;
}

// end_turn's waitFor: the threads this one hibernates until they finish
// (runner/hibernation.ts, waitOn). Like snooze, only with needs "nothing".
export const MAX_WAIT_FOR = 5;
// Each is a thread id, or { thread, until } to wait until it has done
// something in particular, which the librarian judges (librarian.ts, met).
export const MAX_UNTIL = 200;
export type WaitFor = { id: string; until?: string };
export function waitForFromTool(input: unknown): WaitFor[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const w = (input as Record<string, unknown>).waitFor;
  if (!Array.isArray(w)) return undefined;
  const out: WaitFor[] = [];
  for (const x of w) {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : undefined;
    const id = (typeof x === 'string' ? x : typeof o?.thread === 'string' ? o.thread : '').trim();
    const until = typeof o?.until === 'string' ? cutSafely(o.until.replace(/\s+/g, ' ').trim(), MAX_UNTIL) : '';
    if (!id || out.some((y) => y.id === id)) continue;
    out.push(until ? { id, until } : { id });
    if (out.length === MAX_WAIT_FOR) break;
  }
  return out.length && needsFromTool(input)?.needs === 'nothing' ? out : undefined;
}

// end_turn's byline: a few words for the row of a thread Mike didn't start.
export const MAX_BYLINE = 80;
export function bylineFromTool(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>).byline;
  if (typeof v !== 'string') return undefined;
  return cutSafely(v.replace(/\s+/g, ' ').trim(), MAX_BYLINE) || undefined;
}

function linksFrom(v: unknown): AskLink[] {
  const out: AskLink[] = [];
  for (const l of Array.isArray(v) ? v : []) {
    if (!l || typeof l !== 'object') continue;
    const r = l as Record<string, unknown>;
    const title = str(r.title, MAX_SHORT);
    const url = str(r.url, MAX_URL);
    if (!title || !url || !LINK_URL.test(url)) continue;
    out.push({ title, url });
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? cutSafely(t, max) : undefined;
}

// Words Mike reads on the card, kept to max but cut at a word with an
// ellipsis, never mid-word: a why cut at 500 characters ended "though you
// m" on 31 Oct 2026, and he couldn't tell it was cut.
function clipText(v: unknown, max: number): string | undefined {
  const t = str(v, Number.MAX_SAFE_INTEGER);
  if (!t || t.length <= max) return t;
  const end = safeEnd(t, max - 1);
  const space = t.lastIndexOf(' ', end - 1);
  // Back to a word's end is a cut too, and may be inside a value with a space in it.
  const at = space > max * 0.6 ? safeEnd(t, space) : end;
  // Taking punctuation off is a cut too (a known value can end in a full stop).
  const tidy = t.slice(0, at).replace(/[\s,;:.-]+$/, '').length;
  return `${t.slice(0, safeEnd(t, tidy))}…`;
}

// These read a model's reply, which content it read can steer, so none of
// them may backtrack: no two runs of whitespace side by side with only
// optional marks between, and a line's rest taken with `[\s\S]*`, which
// can't fail, rather than `.*$`, which a lone \r or U+2028 made fail after
// trying every split. "What I need from you" then a few thousand spaces and
// a full stop took minutes to hours (Gautam's scan, F26). headingOf and
// itemOf say no where `.*$` did, so the answers are the same.
//
// The heading starts a line, in bold or as a # heading (a plain mention in
// a sentence isn't one), with a colon either side of the ** or none.
// Text after it on the same line ("**What I need from you:** nothing right
// now") is the section's first line.
const HEADING = /^\s*(#{1,6}\s+)?(?:(\*\*)\s*)?What I need from you\s*:?\s*(\*\*)?\s*:?\s*([\s\S]*)/i;
// Without a heading, a closing "Nothing needed from you right now" says it.
const NOTHING_LINE = /(?:^\**\s*|[.!]\s+(?:\*+\s*)?|\band\s+(?:\*+\s*)?)nothing (?:else )?(?:is )?needed from you\b/i;
const ITEM = /^(\s*)(\d{1,2}[.)]|[-*•])\s+([\s\S]*)/;
const headingOf = (line: string) => noBreakInRest(HEADING.exec(line), 4);
const itemOf = (line: string) => noBreakInRest(ITEM.exec(line), 3);
function noBreakInRest(m: RegExpExecArray | null, rest: number): RegExpExecArray | null {
  return m && !hasLineBreak(m[rest]) ? m : null;
}
const NOTHING = /\bnothing\b(?:[^.\n]{0,40}\b(?:needed|from you|for you to do)\b|\s+(?:right now|for now|yet)\b)/i;
// How far from the end the heading may be: agents sometimes quote it
// earlier in a message, and the real one closes it.
const NEAR_END_LINES = 40;

// The section in a final message, or undefined when there isn't one.
export function needsFromText(text: string): Needs | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let at = -1;
  let first = '';
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - NEAR_END_LINES; i--) {
    const m = headingOf(lines[i]);
    if (m && ((m[2] && m[3]) || (m[1] && !m[2]))) {
      at = i;
      first = m[4].trim();
      break;
    }
  }
  if (at < 0) {
    const tail = lines.slice(-NEAR_END_LINES);
    const i = tail.findIndex((l) => NOTHING_LINE.test(l));
    return i < 0 ? undefined : done(nextFromList(tail.slice(i + 1)));
  }
  const body = lines.slice(at + 1);
  const items: string[] = [];
  const prose: string[] = first ? [first] : [];
  let inItem = false;
  let inFence = false;
  // The list's own kind (numbered or bulleted) and indent, from its first
  // item. A deeper item, or one of the other kind ("Pick one:" then its
  // choices), belongs to the ask above it.
  let top: { indent: number; numbered: boolean } | undefined;
  for (const line of body) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : itemOf(line);
    if (m) {
      const kind = { indent: m[1].length, numbered: /\d/.test(m[2]) };
      top ??= kind;
      if (items.length && (kind.indent > top.indent || kind.numbered !== top.numbered)) items[items.length - 1] += ` ${m[3]}`;
      else items.push(m[3]);
      inItem = true;
    } else if (!line.trim()) {
      // A blank line ends an item's continuation, not the list: items are
      // often a blank line apart.
      inItem = false;
    } else if (inItem || inFence || (items.length && /^\s{2,}\S/.test(line))) {
      items[items.length - 1] += ` ${line.trim()}`;
      inItem = true;
    } else if (!items.length) {
      prose.push(line.trim());
    } else {
      // Prose after the list (what the agent will do meanwhile) isn't an ask.
      break;
    }
  }
  const para = prose.join(' ').trim();
  if (!items.length) {
    if (!para || NOTHING.test(para)) return { needs: 'nothing' };
    return { needs: 'you', asks: [askFrom(para)] };
  }
  // "Nothing right now. Worth doing next:" then a list: follow-ups, not asks.
  if (NOTHING.test(para)) return done(items.map(nextFrom));
  if (items.length === 1 && NOTHING.test(items[0])) return { needs: 'nothing' };
  return { needs: 'you', asks: items.slice(0, MAX_ASKS).map(askFrom) };
}

// Mike's instructions ask for any follow-up after "Nothing needed from you
// right now", which agents write as a list: "Two follow-ups are worth
// doing:" then a bullet each. With no end_turn to carry them, the done
// card showed none (30 Oct 2026, thread 13096d04). So a list in the lines
// after it, with at most a line of lead-in before it, is the card's next.
// Prose after the list ends it, and prose with no list is no follow-up.
function nextFromList(lines: string[]): string[] {
  const items: string[] = [];
  let lead = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : itemOf(line);
    if (m && (!items.length || m[1].length === 0)) items.push(m[3]);
    else if (m || (items.length && /^\s{2,}\S/.test(line))) items[items.length - 1] += ` ${line.trim()}`;
    else if (!line.trim()) continue;
    else if (items.length || inFence || ++lead > 1) break;
  }
  return items.map(nextFrom);
}

// A follow-up as the message that would start it, for a row on the done
// card: "**Check your next call:** confirm Bruce used Nemotron on it. Its
// service is untested." becomes "Check your next call: confirm Bruce used
// Nemotron on it". Only the first sentence, as the rest says why.
const NEXT_LINK = { titleStopsAtNewline: false, titleMin: 1, titleMax: Infinity, targetStopsAtSpace: false, targetMin: 0 };
function nextFrom(item: string): string {
  // A link's text: replaceLinks is `/\[([^\]]+)\]\([^)]*\)/g` read once,
  // as that was quadratic on a long run of "[" in a model's reply.
  const t = replaceLinks(item, NEXT_LINK, (title) => title)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // Each cut (the first sentence, the length, back to a word) is placed in
  // the whole text, so none is inside a secret (safe-cut.ts).
  const sentence = safeEnd(t, /^.+?[.!?](?=\s|$)/.exec(t)?.[0].length ?? t.length);
  const first = t.slice(0, safeEnd(t, t.slice(0, sentence).replace(/\.$/, '').length));
  if (first.length <= MAX_NEXT_CHARS) return first;
  const end = safeEnd(t, MAX_NEXT_CHARS);
  const space = t.lastIndexOf(' ', end - 1);
  const cut = space > 0 ? safeEnd(t, space) : Math.max(end, 1);
  return t.slice(0, safeEnd(t, t.slice(0, cut).replace(/[,;:]$/, '').length));
}

// "Open X, add Y, then reply 'done'" names the words to send back.
const REPLY = /\b(?:reply|send(?: back)?|say|answer|respond)(?: with)?\s+["'“‘`]([^"'”’`\n]{1,40})["'”’`]/i;
// Each further quoted choice after it: 'Reply "filter" or "wait"', or
// 'Reply with "Land it", "Website, then land it", or what else to change'.
const MORE = /^\s*(?:,\s*(?:or\s+)?|or\s+|\/\s*)["'“‘`]([^"'”’`\n]{1,40})["'”’`]/i;

function askFrom(item: string): Ask {
  const action = cutSafely(
    item
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
    MAX_ACTION,
  );
  const ask: Ask = { action };
  const reply = REPLY.exec(action);
  if (!reply) return ask;
  const choices = [reply[1].trim()];
  let rest = action.slice(reply.index + reply[0].length);
  for (let m = MORE.exec(rest); m && choices.length < MAX_OPTIONS; m = MORE.exec(rest)) {
    choices.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  // One is the words to send back; several are a choice, each its own
  // button. Taking just the first of a list left Mike one button where
  // the agent had offered two (28 Oct 2026).
  if (choices.length > 1) ask.options = choices;
  else ask.reply = choices[0];
  return ask;
}

// end_turn's description doubles as the instructions: a resumed Claude
// session keeps the system prompt it started with, but sees every tool's
// description afresh.
const END_TURN_WHAT =
  'Ends the turn: says what it did (summary) and whether the user has to do anything (asks), so Threadbear can put the thread in Needs you or leave it as done. ';

// Mike, 29 Oct 2026, after Codex desktop: the least context to load when
// he comes back to a thread, then what's next, with links back into the
// detail. Later that day the bullets hid two answers (an explanation, a
// Sentry report), so a final message that says more than them is the
// Mac app's reply (TranscriptReducer.replyItems). In 36 test sessions, bullets asked for in the final message
// came back as prose from Opus every time; in here, as bullets every time
// (docs/end-turn-design). The links' quote-a-step rule is what models
// managed: they can't see their tool calls' ids.
const SUMMARY_BULLETS = '2 to 5 markdown bullets of what happened this turn (what you found, changed, shipped or decided, with the result), each one line of about 15 words at most, in plain words that make sense to someone who has forgotten the task. ';
const SUMMARY_STANDS_ALONE = 'Never point at something "above": the user may only see the bullets. Leave what the user has to do to the asks. If they asked a question, the first bullet answers it. ';

const END_TURN_SUMMARY_IS_THE_REPLY =
  'summary is what the user reads first when they come back to the thread, often hours later and among many others: ' +
  SUMMARY_BULLETS +
  "The preview, notifications and the phone show it as your reply. In the Mac app, what you write after your last step (before end_turn) is the reply when it says more than the bullets, and the bullets fold into your working with everything else; otherwise the bullets are the reply. So when the answer is an explanation or a report, write it as your message and make the bullets a short version that stands on its own; when it isn't, don't repeat the bullets in a message. " +
  SUMMARY_STANDS_ALONE;

// Bullet replies off (Settings > General): Mike, 30 Oct 2026, liked the
// folded working but wanted the agent's normal message as the reply. The
// bullets stay, as previews and notifications need something short.
const END_TURN_SUMMARY_IS_THE_PREVIEW =
  'Write your reply as an ordinary message, as you would with no tool to call: the result and what the user needs to know, at the length it deserves. In the Mac app that message is the reply, and the summary folds into your working with everything else. ' +
  'summary is the short version the preview, notifications and the phone show: ' +
  SUMMARY_BULLETS +
  SUMMARY_STANDS_ALONE;

const END_TURN_SUMMARY_LINKS =
  'Link each bullet to where they can check it: a web page or a file as an ordinary markdown link; another thread as [its own thread](thread:<its id from list_threads>); a step in your own working this turn as work: and a few words copied exactly from that step (the command you ran or its description, the file you edited, or a line you wrote while working), e.g. [tests pass](work:npm test), which opens your working at that step and lights it up. Links work in the asks too. ' +
  // Mike, 29 Oct: a turn that waited for the app to restart, then the
  // check after it, left two summaries. The app now shows a runner's turn
  // and the turns before it back to Mike's message as one, with the last
  // summary as the reply (docs/protocol.md, "The summary").
  "When this turn started from a message the runner sent rather than one from the user (the app restarted, a hook ran, the resume after a restart), this summary takes the place of your last one, so cover everything since the user's last message, not just this turn; work: links can quote steps from those turns too. " +
  'Leave summary out only when the turn was a line or two of conversation, and write that as an ordinary message. ';

// How to write a follow-up row. Mike kept pressing the ? on rows like
// "Sandbox sample in the Mac app's HangWatch too" and "Stop Walkies being
// blamed for the audio wakelock" (30 Oct to 1 Nov): the agent's shorthand,
// with nothing to say why it came up. "Must make sense on its own" didn't
// help: at least 113 of the 149 cards with rows came after that line landed,
// and in replays of those turns it did no better than leaving it out. A cold reader got why a row
// was there about twice as often with this (0.31 to 0.58 on Opus), so it asks
// for the reason in the row instead of adding a field for it
// (~/dev/me/misc/end-turn-eval/next-rows). The longer rows wrap on the card.
const NEXT_ROW =
  'Each is a row on the done card that the user reads hours later, with this thread forgotten and nothing else to go on, and ticking it sends it to you as their own message. ' +
  'So write it in their voice, as an instruction: which app or thing it\'s about and what they\'d see change or get, in words they\'d use, with the reason in the same line if it isn\'t obvious. ' +
  'No names from the code or your working (a class, a file, a tool, a nickname for something); describe what it does instead. ' +
  '8 to 15 words: "Stop the Threadbear transcript jumping when a long reply arrives", not "Fix the ScrollAnchor drift". ';

// Hibernating itself, in every form's description (snoozeFromTool).
const END_TURN_SNOOZE =
  'snooze hibernates this thread once the turn is over, with needs "nothing" only, until a time ("2h", "1d", "tomorrow", an ISO time with its offset, "restart", or "release" for a new release) or words saying when ("when the phone arrives"). Use it when the user asks for this thread to be snoozed or hibernated, or when the rest waits on a message (one wakes it), until it should have come; waitFor names threads it waits on, which wake it when they finish. ';

// Handing a step over, in every form's description. This used to say to offer
// "Can you do it?" when the agent could plausibly do the step itself, which told
// it to ask rather than try: the user was answering that button, in those words,
// on steps like resolving a Sentry issue with the tool right there (29 Oct to
// 2 Nov 2026). The button stays for what's left after a real try.
export const TRY_IT_FIRST =
  'Before you give the user a step, try it yourself with the tools you have, including any that drive their browser, apps or phone, and if it works there is no ask. ' +
  'Hand it over only when it really needs them (a payment, something physical, an approval that is theirs to give) or after a real attempt, and say in your reply what you tried and what stopped it. ' +
  'A password, key or code is no reason to stop: ask for it with ask_secret and carry on. ' +
  'If there is still something you could try, offer "Can you do it?" next to Done and say what in its answer: it lets them send the step back to you, and is no reason to skip trying. ';

// What end_turn says, once a turn, to a card offering to take a step back. The
// wording alone didn't get steps tried: in replays of real turns agents still
// offered the button with no try at the step, and this note brought a real try
// every time (6 of 6). It came up once in 15 runs on a sign-in or payment card,
// and forced onto those, agents sent the card again unchanged, paying nothing
// and signing in to nothing (~/dev/me/misc/end-turn-eval/try-first). Whether
// a turn tried can't be read from its tool calls, as nearly all of them were
// busy with something else (29 Oct to 1 Nov 2026), so it asks the agent, and an
// agent that did try or can't only spends one more call.
export const TRY_FIRST_NUDGE = 'Not ended: this card offers to have you do a step yourself.';
export function tryFirstNudge(): string {
  return `${TRY_FIRST_NUDGE} If you could try that step and haven't, try it now, then call end_turn again with whatever is left. If you already tried, or it really needs the user (a password or code, a payment, something physical, an approval that is theirs to give), call end_turn again as you were, and say in your reply what you tried or why it needs them: this note comes once a turn.`;
}

// An answer that hands a step back to the agent. By its label, as the wording
// asks for these words and agents keep to them: "Can you do it?", "Can you do
// it in Chrome?", "Connected, you do it", "Do it for me later".
const TAKES_IT_BACK = /\b(?:can|could|would) you\b.*\b(?:do|try|handle|run)\b|\byou do it\b|\bdo (?:it|them|this|that) for me\b|\btry it yourself\b/i;
export function offersToTakeItBack(asks: Ask[]): boolean {
  return asks.some((a) => a.options?.some((o) => TAKES_IT_BACK.test(o)));
}

// Whether this turn has had the note (connectors.ts, nudgedThisTurn, is the same).
export function triedFirstNudged(events: PersistedEvent[]): boolean {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  return events.slice(start).some((e) => e.type === 'tool.result' && typeof e.text === 'string' && e.text.startsWith(TRY_FIRST_NUDGE));
}

// A change only Mike can judge, left as a soft line at the end of a done
// reply. On 6 Nov 2026 (thread 524cd997) two turns in a row put Whisper
// dictation on his phone with needs "nothing" and ended "I haven't heard how
// Whisper does on the phone yet. If it's slow or mishears things, tell me",
// while he was in the middle of trying it; he asked why it wasn't in Needs
// you. Waiting for something to turn up later by itself stays "nothing".
// Replays: ~/dev/me/misc/end-turn-eval/needs-you.
export const ONLY_THEY_CAN_TRY =
  'When only the user can tell whether what you made works (their voice, their phone, how it feels to use) and nobody has tried it yet, trying it is an ask, with needs "you" ("Dictate a sentence on your phone and tell me what it typed"), not an "if it\'s off, tell me" line at the end of your reply. Something that will only show up later by itself (the next thread that hits it) is no ask. ';

// What to put in it, the same for both providers.
const END_TURN_ASKS =
  'needs "nothing" when the work is finished (or still going by itself) and nothing waits on the user. ' +
  'needs "you" when it does: an approval, a decision, a key, something to look at, a question. Give one ask per thing they have to do, most blocking first. ' +
  ONLY_THEY_CAN_TRY +
  'The asks are your "What I need from you" list: the user reads and answers them in a card under your message, each drawn as one paragraph of message text, its action then its why, with its buttons under it. So don\'t also list them in your message. ' +
  'Write each ask the way you would in that list, so it makes sense on its own to someone who has forgotten everything: action is its first sentence, the thing to do or the question ("Next time you leave the room, take your phone and leave the laptop idle on power."); why carries on the same paragraph with what it is about and what you want back, in a sentence or two ("It should lock within a minute of you going. Tell me whether it did, and I\'ll tune the Bluetooth cutoff."). Say where in it when it matters (System Settings › Bluetooth), and name things rather than places (not "Slack #channel", but "Your Slack draft to Emily names the automation guy Hayden; he is Pete"). When one ask is several questions or choices, end its why with them as a short markdown list, one per line, rather than running them together. ' +
  'Give links whenever there is somewhere to go to do it or judge it: the page to log in on, the Slack message (its permalink), the PR, the preview, the file or screenshot to look at, the project to open (a path opens in its own app, e.g. a .key file in Keynote), or review:<id> for a show_options review in this thread (its window, to compare and pick). Each is a button on the ask, so title it as the action ("Open login page", "Open the Slack message", "Open Short 4 in Tandem"). ' +
  // Mike, 29 Oct: an ask said "Look at the screenshots in Highlights" in
  // plain words over a "See the tab" button for the same screenshot.
  'The paragraph is markdown, so where action or why names the thing a link opens, make those words a link to the same url ("Look at [the pairing screenshot](/Users/you/shots/pair.png) and say whether to land it."): the user can hover them for a peek or click them, and the button stays as the next step. ' +
  'Every decision or yes/no question needs options: 2 to 4 short likely answers, e.g. ["Go", "Not yet"] or ["Merge", "Test locally first"], with suggested: the index of the one you would pick. "Say go for X, or name another" is a decision too: give ["Go", ...the other candidates]. The user can always write their own answer instead, so options never box them in. ' +
  TRY_IT_FIRST +
  // Mike, 30 Oct: a follow-up in the closing prose, over a card that only
  // offered Archive, got buried and forgotten. Not make-work, though.
  'next is for needs "nothing": up to 3 follow-ups in this thread worth doing, so they don\'t get lost: a piece still missing, a check that\'s due, something you or the user raised and didn\'t get to. Only ones that really came up; never invent work, and most turns have none, so leave it out then. ' + NEXT_ROW + 'Don\'t also list them in your message. ' +
  'archive: true archives this thread once the turn is over, with needs "nothing" only. Use it only when the user asks for this thread to be archived, or the message that started the thread says to; otherwise leave it out, as a thread that vanishes from their inbox when they hadn\'t finished with it is confusing. ' +
  END_TURN_SNOOZE +
  'If you leave sub-agents running, the thread stays under Running and your asks don\'t reach the user\'s inbox until the sub-agents finish and you\'ve ended a later turn, so don\'t leave one waiting on the user. ' +
  'Sub-agents never call this; only the thread\'s own agent does.';

export const END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as the very last thing in every turn, and write nothing after it. ' +
  END_TURN_SUMMARY_IS_THE_REPLY +
  END_TURN_SUMMARY_LINKS +
  "With a summary, you needn't write a message first when the bullets are the whole answer. When the user asked for something to read (details, a list, steps, a draft, an explanation), write it as your message before you call end_turn: a bullet like \"Put together the details you need\" points at nothing unless the details are in a message. Without one, it is refused until the turn has a reply: ordinary text from you after your last tool result (Threadbear's own tools aside), so the user gets a complete answer in the conversation. " +
  END_TURN_ASKS;

// Codex's: its final answer ends the turn, so nothing can be called after
// it. Told to call end_turn after its final message, Codex never once
// did; GPT-6.1-Sol wrote the call into its final answer instead, raw
// tool-call tokens and all, and Mike read them (28 Oct 2026).
const CODEX_END_TURN_HOW = 'Call it through your tools like any other; never write the call, or its result, in your message. ';

export const CODEX_END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as your last tool call, just before your final answer: the final answer ends the turn, so nothing can be called after it. ' +
  CODEX_END_TURN_HOW +
  END_TURN_SUMMARY_IS_THE_REPLY +
  END_TURN_SUMMARY_LINKS +
  'With a summary, your final answer can be one short line: it folds into your working, as the user reads the summary instead. ' +
  END_TURN_ASKS;

// With bullet replies off. A session sees these when its CLI starts; one
// already live goes by what end_turn's handler answers until then.
const MESSAGE_END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as the very last thing in every turn, and write nothing after it. ' +
  END_TURN_SUMMARY_IS_THE_PREVIEW +
  END_TURN_SUMMARY_LINKS +
  "It is refused until the turn has that message: ordinary text from you after your last tool result (Threadbear's own tools aside). " +
  END_TURN_ASKS;

const CODEX_MESSAGE_END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as your last tool call, just before your final answer: the final answer ends the turn, so nothing can be called after it. ' +
  CODEX_END_TURN_HOW +
  END_TURN_SUMMARY_IS_THE_PREVIEW.replace('an ordinary message', 'your final answer').replace('that message', 'that answer') +
  END_TURN_SUMMARY_LINKS +
  END_TURN_ASKS;

// One reply (docs/protocol.md, "One reply"; docs/reply-card-design): the
// agent calls end_turn first, with the card and a headline, then writes
// its reply as its final message. Its context was written up to three
// times (message, bullets, why), each told to stand alone, and Opus sent
// the message as narration, which reaches us only paraphrased. A message
// with no tool call after it is never narration, and it's where models
// write their answer anyway: in 32 eval sessions this wording lost no
// replies (today's lost the agent's words in 6 of 16), and wrote the reply
// twice in 2 runs where putting it inside end_turn did in 9
// (~/dev/me/misc/end-turn-eval/v3). Codex already worked in this order.
// The "lost track" line: six times from 30 Oct to 5 Nov 2026 Mike had to
// ask what a piece of work was ("Sorry, I'm not really following") after a
// long turn or in a thread another agent started, as the reply reported
// only the latest step (28cee9ef: one experiment's result, never the plan
// it was for). One line, only then: he likes replies at their usual length.
const ONE_REPLY_REPLY =
  'Then write your reply as ordinary text straight after it, as your final message. ' +
  'That reply is the only text the user sees from this turn: everything you write before end_turn folds away into your working, out of sight. So don\'t write your answer before calling it, and call no tools after it. ' +
  'The reply: lead with the point and keep it as short as it can be while they can act on it without reading your working. ' +
  'If they may have lost track (a long turn, work picked up from another thread, a thread they didn\'t start), open with one line on what the work is for and where it stands, before the latest step. ' +
  'A work report is a few bullets of what changed and the result, each linked to where it can be checked: [tests pass](work:npm test) quotes a few words of a step in your working (the command you ran or its description) and opens it there, lit up; [its own thread](thread:<its id from list_threads>) opens another thread; web pages and files link as usual. ' +
  'An explanation, a draft or an answer to their question is prose, at the length it needs. ' +
  'When you\'re asking something, include the full draft to approve (text to send elsewhere goes in a ```slack, ```email or ```draft block, shown line for line with a Copy button) or the options to choose from in the reply. The question itself, and what each answer would do, are in the card under the reply, so don\'t repeat them. ' +
  'Never write a "What I need from you" section, a "Nothing needed from you" line or a list of follow-ups in the reply: asks and next are those. ';

// Only what the fields' own descriptions don't say (threadbear-mcp.ts):
// each field's rules sat in both until 4 Nov 2026, and every thread read
// them twice (runner/context-budget.json). Checked in the end_turn eval
// (~/dev/me/misc/end-turn-eval/v3, "trim") before landing.
const ONE_REPLY_FIELDS =
  TRY_IT_FIRST +
  ONLY_THEY_CAN_TRY +
  'next is only for when nothing is needed: up to 3 follow-ups that really came up and that you\'d tell the user are worth doing; usually none, and never something you\'d call optional or low priority. ' +
  NEXT_ROW +
  'If you leave sub-agents running, the thread stays under Running and your asks don\'t reach the user\'s inbox until the sub-agents finish and you\'ve ended a later turn, so don\'t leave one waiting on the user. ' +
  'Sub-agents never call this; only the thread\'s own agent does.';

const ONE_REPLY_WHAT =
  'Ends the turn\'s work and sets up what the user sees under your reply: the card of asks, or the done card. ' +
  'Call it once, when the work is finished. ';

export const ONE_REPLY_DESCRIPTION = ONE_REPLY_WHAT + ONE_REPLY_REPLY + ONE_REPLY_FIELDS;
export const CODEX_ONE_REPLY_DESCRIPTION = ONE_REPLY_WHAT + CODEX_END_TURN_HOW + ONE_REPLY_REPLY.replace('your final message', 'your final answer') + ONE_REPLY_FIELDS;

export function endTurnDescription(provider: 'claude' | 'codex', bulletReplies: boolean, oneReply = false): string {
  if (oneReply) return provider === 'codex' ? CODEX_ONE_REPLY_DESCRIPTION : ONE_REPLY_DESCRIPTION;
  if (provider === 'codex') return bulletReplies ? CODEX_END_TURN_DESCRIPTION : CODEX_MESSAGE_END_TURN_DESCRIPTION;
  return bulletReplies ? END_TURN_DESCRIPTION : MESSAGE_END_TURN_DESCRIPTION;
}

// What an accepted one-reply end_turn says: the reply comes next. The
// runner knows the result by these words and keeps the text after it as
// the turn's reply (runner.ts, onOutput).
export const ONE_REPLY_NEXT = 'Now write your reply';

export function oneReplyAccepted(needsYou: boolean, restart = '', wroteFirst = false): string {
  const first = wroteFirst ? WROTE_FIRST : '';
  return needsYou
    ? `${ENDED} will wait in Needs you.${restart} ${ONE_REPLY_NEXT}: it's the only text the user sees from this turn, with the card of asks under it. ${first}${ASKS_NEED_THE_REPLY} Leave the question and button labels on the card, and write nothing after your reply.`
    : `${ENDED} is done. ${ONE_REPLY_NEXT}: it's the only text the user sees from this turn. ${first}Write nothing after it.`;
}

// Drafts and options written before end_turn are hidden with the work.
// Ask for the answer the user needs, rather than reproducing that work:
// the old "write it again in full" result immediately preceded an
// Anthropic reasoning_extraction refusal (6 Nov 2026, thread ba756ff4).
const WROTE_FIRST =
  'Give a self-contained answer with the result and supporting evidence. Include any requested draft, explanation or descriptions of choices in full. ';
const ASKS_NEED_THE_REPLY =
  'If the user needs a draft or descriptions of choices to decide, include them in full.';

// For an end_turn the Stop hook asked for, in a turn that has its message:
// the nudge said "your message above is the reply", and "Now write your reply"
// after it got a second message, which took the first's place. On 1 Nov 2026
// that was 13 of 84 one-reply turns, one trading 2,359 characters for 96, and
// a real answer folded under "The bear picture test is still waiting on you".
const MESSAGE_STANDS = 'your message above is the reply';
export function oneReplyAlreadyWritten(needsYou: boolean, restart = ''): string {
  return needsYou
    ? `${ENDED} will wait in Needs you.${restart} Stop here, with no more text: ${MESSAGE_STANDS}, the asks go in a card under it, and nothing written now reaches the user.`
    : `${ENDED} is done. Stop here, with no more text: ${MESSAGE_STANDS}, and nothing written now reaches the user.`;
}

// That answer, read back: the turn has its reply, so the Stop hook doesn't
// ask for one (adapter.ts), and any summary bullets a session on the old
// form sent don't take the message's place (runner.ts).
export function endTurnMessageStands(result: { ok: boolean; text: string }): boolean {
  return endTurnAccepted(result) && result.text.includes(MESSAGE_STANDS);
}

// An end_turn answered by the one-reply handler: the reply is a message, the
// next one or the one above, so bullets from a session on the older form
// don't stand in for it.
export function endTurnIsOneReply(result: { ok: boolean; text: string }): boolean {
  return endTurnWantsReply(result) || endTurnMessageStands(result);
}

// What a Claude end_turn that fits neither form hears. Says the shape in
// words, as the agent can't look it up: a session keeps the definition it
// first loaded, and ToolSearch shows that one too (threadbear-mcp.ts, endTurn).
// An agent on 1 Nov 2026 got a bare zod error and had to read the source
// (thread 1b770c6a).
export function endTurnMisfit(problem: string, oneReply: boolean): string {
  const shape = oneReply
    ? '{ headline?, needs?, asks?: { question, options?: { label, does? }[], suggested?, links? }[], next?, archive?, snooze?, waitFor? }, then write your reply after it, as ordinary text: that reply is the only text the user sees from the turn.'
    : '{ needs?, summary?: string[], asks?: { action, why, reply?, options?: string[], suggested?, links? }[], next?, archive?, snooze?, waitFor? }, after writing your reply as ordinary text, with nothing after the call.';
  return `Not ended: those arguments don't fit end_turn.\n${problem}\nCall it with ${shape} Go by this rather than the tool's description, which can be out of date in a session this old, and reloading it won't change that.`;
}

export function endTurnWantsReply(result: { ok: boolean; text: string }): boolean {
  return endTurnAccepted(result) && result.text.includes(ONE_REPLY_NEXT);
}

// The Stop hook's nudges with one reply (adapter.ts, onStop): a turn that
// ended without end_turn already has its message, which the app shows as
// the reply; one that took end_turn and wrote nothing after it is asked
// for its reply once.
export const ONE_REPLY_END_TURN_NUDGE =
  'This turn ended without end_turn, so Threadbear has no card for it. ' +
  'Call end_turn now (load it with ToolSearch first if you need to), with needs and any asks or next follow-ups from what you just wrote. ' +
  "Your message above is the reply: don't write it again.";
export const ONE_REPLY_WRITE_NUDGE =
  'Write your reply now, as ordinary text: the user sees only what you write after end_turn, with the card under it. ' +
  'Include any requested draft, explanation or descriptions of choices in full. Leave the question and button labels on the card.';

// What a compaction between an accepted one-reply end_turn and its reply
// adds after the summary (adapter.ts, onCompact), with the card's
// questions, as the summary may not have them.
export function owedReplyAfterCompact(questions: string[]): string {
  const card = questions.length ? ` The card under it asks: ${questions.map((q) => `"${q}"`).join(', ')}.` : '';
  return (
    'Before this conversation was compacted you called end_turn, it was accepted, and you had not yet written your reply.' +
    card +
    " Write the reply now, as ordinary text, before any tool call: it's the only text the user sees from that turn. " +
    'Nothing you wrote before end_turn reached them, so whatever the card is about (a plan, a draft, the options) goes in it in full. Then stop.'
  );
}

// A reply that ends in a "What I need from you" section, or a "Nothing
// needed from you" line, comes apart into the reply above it and what the
// section says (needsFromText). With one reply, Sonnet wrote the section
// into its reply in 4 of 16 eval sessions and left end_turn's asks empty,
// so a turn whose end_turn has no asks or follow-ups takes its card from
// here, and the reply loses the section the card now shows. The heading
// may be a line on its own with no bold or #, as Sonnet wrote it.
// Each optional mark after it takes the whitespace before it, so no two
// runs of whitespace meet (that was O(n^4) on a run of spaces, F26).
const BARE_HEADING = /^\s*(?:#{1,6}\s+)?(?:\*\*\s*)?What I need from you(?:\s*:)?(?:\s*\*\*)?(?:\s*:)?\s*$/i;
export function splitReplySection(reply: string): { reply: string; needs?: Needs } {
  const lines = reply.replace(/\r\n/g, '\n').split('\n');
  const from = Math.max(0, lines.length - NEAR_END_LINES);
  for (let i = lines.length - 1; i >= from; i--) {
    const m = headingOf(lines[i]);
    const heading = BARE_HEADING.test(lines[i]) || (m && ((m[2] && m[3]) || (m[1] && !m[2])));
    if (!heading) continue;
    const section = lines.slice(i);
    // A bare heading becomes a bold one so needsFromText reads it.
    section[0] = `**What I need from you:** ${(m?.[4] ?? '').trim()}`.trimEnd();
    const needs = needsFromText(section.join('\n'));
    return needs ? { reply: lines.slice(0, i).join('\n').trimEnd(), needs } : { reply };
  }
  for (let i = from; i < lines.length; i++) {
    if (!NOTHING_LINE.test(lines[i]) || !/^\W*nothing/i.test(lines[i].replace(/^[\s*_#>-]+/, ''))) continue;
    const needs = needsFromText(lines.slice(i).join('\n'));
    return needs ? { reply: lines.slice(0, i).join('\n').trimEnd(), needs } : { reply };
  }
  return { reply };
}

// A reply under a card of asks, without a closing section that writes the
// card out again. Opus does this despite the description and end_turn's result
// both saying not to, and the repeat reads as the card not having been used
// (thread 7ac017b7, 3 Nov 2026). A section listing more than the card has
// stays, as the extra ask is nowhere else: better a repeat than a lost request.
// Prose after the list stays too: three of that thread's six had a follow-up
// there, and a card of asks doesn't show follow-ups.
export function replyWithoutRepeat(reply: string, card: Needs): string {
  const whole = reply.replace(/\r\n/g, '\n');
  const split = splitReplySection(whole);
  const asked = split.needs?.needs === 'you' ? split.needs.asks?.length ?? 0 : 0;
  if (!asked || asked > (card.asks?.length ?? 0)) return reply;
  const after = proseAfterList(whole.slice(split.reply.length).split('\n'));
  return after ? `${split.reply}\n\n${after}` : split.reply;
}

// What follows a section's list, by the same reading as needsFromText, which
// stops there as it isn't an ask.
function proseAfterList(lines: string[]): string {
  let seen = false;
  let inItem = false;
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && itemOf(line)) seen = inItem = true;
    else if (!line.trim()) inItem = false;
    else if (seen && !inItem && !inFence && !/^\s{2,}\S/.test(line)) return lines.slice(i).join('\n').trimEnd();
  }
  return '';
}

// What end_turn says when the turn has no reply yet. An error result, so
// the CLI doesn't take the call as the end of the turn (adapter.ts,
// CLAUDE_CODE_TERMINAL_MCP_TOOLS) and the agent reads it. Ask for the whole
// answer, as a shorter reminder once got Mike only a closing line.
// Describe the result he needs: wording that asks for internal reasoning
// can trigger a provider safeguard even during ordinary work. An agent
// that believed it had written its answer read the old wording as the
// check being broken (a refused end_turn counted as its tool result),
// wrote one line about that, and Mike never got the answer (28 Oct 2026):
// so say a refusal isn't a tool result, and that an answer it thinks it
// gave never arrived.
export const NO_REPLY =
  "Not ended: the user hasn't had a reply this turn. No message text from you has reached them since their latest message and your latest tool result (a refused end_turn isn't a tool result). " +
  "If you think you already answered, they haven't seen any of it. " +
  'Please write the whole answer as ordinary text, with the result and any supporting evidence the user needs. Then call end_turn again.';

// What an accepted end_turn adds when the turn's reply reached Mike only
// as a narration block's summary (TurnReply.narrationOnly), and end_turn
// brought no summary bullets of its own. On 29 Oct 2026 a step-by-step
// walkthrough reached him as "I've resent the full step-by-step setup
// instructions...", twice (thread 66935d23): the agent had written it in
// a narration block, which the API sends only summarised. Each time the
// agent wrote the whole thing again after end_turn anyway, and the runner
// dropped it as a repeat. Now the runner keeps that text in the summary's
// place (runner.ts, onOutput), and this asks for it. A text block with no
// tool call after it is never narration, so "nothing after it" matters.
export const NARRATION_ONLY =
  'The user got only a short summary of your last message, not its words. ' +
  'Write the whole message again now, as ordinary text with nothing after it: it takes the summary\'s place.';

// What an accepted end_turn with summary bullets adds when the turn has
// no message of its own since its last step, so the bullets are all the
// user has. On 30 Oct 2026 (thread 2a0a9c2c) Mike asked for the details
// he needed for a call to Qantas, and Opus called end_turn first, with
// "Put together the details you'll need for the call" as a bullet. Told
// to stop, it wrote the details anyway, and the runner dropped them as a
// repeat, twice: he got bullets pointing at nothing. Whether the bullets
// stand for words not yet written is for the agent to say, as no wording
// gives it away ("put together", "here are", "below"). The runner keeps
// the one message that follows when it says more than the bullets
// (runner.ts, owedReply), and the app shows it as the reply
// (TranscriptReducer, reply(of:)).
// It used to ask outright whether the bullets stood for a message not
// yet written. Agents took that as "write one": all 14 bullets-only
// turns in the next four hours wrote a prose repeat of their bullets,
// which then showed in place of them (30 Oct 2026). So it only says to
// stop, in words the runner can tell apart from the other results; an
// agent that meant to write its answer after end_turn, as the Qantas one
// did when told to stop, still has it kept.
export const BULLETS_ONLY = 'Stop here, with no more text: the user has your bullets';

// Whether an accepted end_turn's result was the bullets-only one
// (BULLETS_ONLY), whose next message the runner keeps.
export function endTurnOwesReply(result: { text: string }): boolean {
  return result.text.includes(BULLETS_ONLY);
}

// With bullet replies off, a turn whose message came as a narration block
// is asked for it again even with bullets (threadbear-mcp.ts). The message
// lands under them, so any length of it is kept, as the app shows it
// whatever its length (TranscriptReducer, reply(of:)).
export function endTurnAsksForMessage(result: { text: string }): boolean {
  return result.text.includes(NARRATION_ONLY);
}

// How every accepted end_turn result starts, so the runner can tell one
// from a refusal by what it says (a refusal's ok flag is only as good as
// the provider's) and drop text written after it.
export const ENDED = 'Noted: this thread';

export function endTurnAccepted(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text.startsWith(ENDED);
}

// Added to an accepted end_turn's result while subagents wait on Mike's cards.
export function openCardsNote(titles: string[]): string {
  if (!titles.length) return '';
  const shown = titles.slice(0, 3).map((t) => `"${t.slice(0, 120)}"`).join(', ');
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : '';
  return ` ${titles.length === 1 ? 'A sub-agent of yours is' : `${titles.length} of your sub-agents are`} parked until the user answers an approval card in this thread, not working: ${shown}${more}. Say so in your reply, rather than calling them running.`;
}

// An end_turn the handler took, Claude's (ENDED) or Codex's ("Noted. Now
// write your final answer"), as opposed to one it refused.
export function endTurnTaken(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text.startsWith('Noted');
}

// The input of the end_turn this turn has already taken, so a second is
// refused: Opus once sent its card four times (29 Oct 2026). A message since
// the call opens the turn again, as it's owed an answer and maybe a card of
// its own: on 1 Nov 2026 Mike's "Archive" from the phone landed just after
// end_turn, and the agent couldn't call it again to do what he asked (thread
// cdfccbc3). The message goes in the events before the CLI gets it, so the
// agent can't have seen one that isn't there yet. One that came while the call
// ran counts too, as the agent called it without having read that message.
// A background task finishing mid-turn (a system.note with wake) opens it too,
// from when the agent has read it (wakeRead). On 7 Nov 2026 a backgrounded
// `tb land` finished just before the agent's "landing now" end_turn, and the
// real report's end_turn was refused (thread 46de9389).
export function takenEndTurn(events: PersistedEvent[], serverName = 'threadbear'): Record<string, unknown> | undefined {
  const endTurn = `mcp__${serverName}__${END_TURN_TOOL}`;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  const calls = new Map<string, Record<string, unknown>>();
  let taken: Record<string, unknown> | undefined;
  const wake = new WakeRead();
  for (const e of events.slice(start)) {
    if (e.type === 'user.message' || wake.see(e)) {
      calls.clear();
      taken = undefined;
    }
    if (e.type === 'tool.call' && e.name === endTurn) calls.set(e.itemId, e.input);
    if (e.type === 'tool.result' && !taken && endTurnTaken(e)) taken = calls.get(e.itemId);
  }
  // Handed over with no step of the agent's since: the SDK can run this call
  // before its own frames reach the events, so it is that step (from Codex's
  // review).
  if (wake.handed) return undefined;
  return taken;
}

// When the agent has read a background task's notification that came into
// its turn (a system.note with wake), fed the turn's events in order. The CLI
// hands it over with the next request to the model, after the next tool
// results: the text and calls of the response that was being written when it
// came weren't written with it, nor were tool results in the same batch, so
// it counts from the agent's first step after a result (see() is true then).
// Shared by takenEndTurn, the runner's turn and the Claude adapter's Stop
// hook, so all three open the turn at the same event.
export class WakeRead {
  private state: 'none' | 'unread' | 'handed' = 'none';
  // One that came while another was handed over: the request may have gone
  // to the model before it, so it waits for results of its own (from Codex's
  // review). At worst that opens the turn once more than needed.
  private next = false;
  get handed(): boolean {
    return this.state === 'handed';
  }
  see(e: { type: string; itemId?: string; wake?: true }): boolean {
    if (e.type === 'system.note' && e.wake) {
      if (this.state === 'handed') this.next = true;
      else this.state = 'unread';
      return false;
    }
    if (e.type === 'tool.result' && this.state === 'unread') this.state = 'handed';
    // A Codex child's items (<child>/<id>) aren't the agent's own steps.
    else if (this.state === 'handed' && (e.type === 'assistant.text' || e.type === 'reasoning' || e.type === 'tool.call') && !e.itemId?.includes('/')) {
      this.state = this.next ? 'unread' : 'none';
      this.next = false;
      return true;
    }
    return false;
  }
  reset(): void {
    this.state = 'none';
    this.next = false;
  }
}

export function endedThisTurn(events: PersistedEvent[], serverName = 'threadbear'): boolean {
  return takenEndTurn(events, serverName) !== undefined;
}

// What the Claude adapter's Stop hook sends back, once, to a turn that
// ended without end_turn (adapter.ts, onStop). The reply already written
// stands, so it asks for the call alone: a fresh message would sit under
// the real answer as the reply.
export const END_TURN_NUDGE =
  'This turn ended without end_turn, so Threadbear has no summary or card for it. ' +
  'Call end_turn now (load it with ToolSearch first if you need to), with the summary, needs, and any asks or next follow-ups from what you just wrote. ' +
  "Your message above is the reply: don't write it again, and write nothing after end_turn.";

export const ALREADY_ENDED = 'Already ended: this turn has had its end_turn, and the user has its summary and asks. Stop here, with no more text.';

// A repeat end_turn that only adds archive: the card that was taken stands
// (runner.ts, onOutput). The repeat could always do this, by accident, under a
// result saying it had been refused. Not ENDED or "Noted": the runner would
// take it for a new end_turn, and write its summary out a second time.
export const ARCHIVE_ADDED = 'Added: this thread will be archived once the turn is over, and the rest of your end_turn stands. If you have written your reply, stop here with no more text.';

// The same for a repeat that only adds snooze (or changes when to wake).
export const SNOOZE_ADDED = 'Added: this thread will hibernate once the turn is over, and the rest of your end_turn stands. If you have written your reply, stop here with no more text.';

export function endTurnRefusedRepeat(result: { text: string }): boolean {
  return result.text.startsWith(ALREADY_ENDED);
}

export function endTurnAddedArchive(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text === ARCHIVE_ADDED;
}

export function endTurnAddedSnooze(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text === SNOOZE_ADDED;
}

// Whether the turn so far has given Mike a reply, for end_turn to check
// before it ends the turn. An agent that drafted its answer in thinking
// and went straight to end_turn left him a folded work group and a card
// of asks, twice in one thread (28 Oct 2026). Those answers, and the
// replies refused on 29 Oct, were thinking blocks signed as narration,
// which the Claude normaliser now makes assistant.text (isNarration);
// this still refuses a turn whose only words were thinking. `events` are the thread's
// recent ones, oldest first; only those after the last turn.started count.
export type TurnReply = {
  // This end_turn call has reached the events (a tool.call for it with no
  // result yet). The CLI writes a call before it runs the tool, so once it
  // is there, so is everything the agent said before it.
  landed: boolean;
  // The agent's own assistant.text after its last tool result from a tool
  // outside the threadbear server, and after the last message from Mike in
  // the turn. The thread's own tools (pin, update_project, an earlier
  // refused end_turn) say nothing he has to read, so a message, then pin,
  // then end_turn is a turn that replied.
  replied: boolean;
  // Every text that counted for `replied` was a summary (a Claude
  // narration block, which reaches the runner only as the API's summary
  // of what the agent wrote), or the last one was and nothing in words
  // followed the last tool call: Mike has a paragraph about the reply,
  // not the reply. end_turn asks for it again (NARRATION_ONLY).
  narrationOnly?: true;
};

// Tools that do nothing Mike would want told about. ToolSearch loads a
// deferred tool's schema (end_turn's, as often as not: "Hello.", then
// ToolSearch for end_turn, then end_turn was refused for having worked
// since the reply).
const PLUMBING_TOOLS = new Set(['ToolSearch']);

export function turnReply(events: PersistedEvent[], serverName = 'threadbear'): TurnReply {
  const ownPrefix = `mcp__${serverName}__`;
  const endTurn = `${ownPrefix}${END_TURN_TOOL}`;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  const names = new Map<string, string>();
  const open = new Set<string>(); // end_turn calls with no result yet
  let lastText = 0;
  let lastWords = 0; // the last text that wasn't a summary
  let lastWork = 0;
  let lastTool = 0; // the last result from any tool but end_turn
  let lastUser = 0;
  for (const e of events.slice(start)) {
    // A Codex child's items carry its prefix (<child>/<id>); Claude's
    // sub-agents never reach the thread's events.
    if ('itemId' in e && typeof e.itemId === 'string' && e.itemId.includes('/')) continue;
    switch (e.type) {
      case 'user.message':
        lastUser = e.seq;
        break;
      case 'assistant.text':
        lastText = e.seq;
        if (!e.narration) lastWords = e.seq;
        break;
      case 'tool.call':
        names.set(e.itemId, e.name);
        if (e.name === endTurn) open.add(e.itemId);
        break;
      case 'tool.result': {
        const name = names.get(e.itemId);
        open.delete(e.itemId);
        if (name !== undefined && !name.startsWith(ownPrefix) && !PLUMBING_TOOLS.has(name)) lastWork = e.seq;
        // ToolSearch too: a status line, ToolSearch for end_turn, then the
        // answer as narration left the status line standing as the reply
        // (Codex's review of the 5 Nov 2026 fix, below).
        if (name !== undefined && name !== endTurn) lastTool = e.seq;
        break;
      }
      default:
        break;
    }
  }
  const since = Math.max(lastWork, lastUser);
  const replied = lastText > 0 && lastText > since;
  // Or the last text was narration, with no words since the last tool of
  // any kind: on 29 Oct 2026 a status line, then read_thread, then the
  // whole explanation as narration, counted as words, so end_turn didn't
  // ask for it again, and the text after end_turn (a repeat of the card)
  // took the narration's place. Words just before the narration, with no
  // tool between, are the reply, so they still count.
  const lastIsNarration = lastText > lastWords && lastWords < lastTool;
  return { landed: open.size > 0, replied, ...(replied && (lastWords <= since || lastIsNarration) ? { narrationOnly: true as const } : {}) };
}
