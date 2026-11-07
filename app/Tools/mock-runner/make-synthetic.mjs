#!/usr/bin/env node
// Writes the synthetic demo threads in fixtures/ (safe to commit: made up,
// no real transcripts). The mock runner serves them alongside any private
// fixtures in app/.fixtures. Re-run after changing this file.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'fixtures');
const home = '/Users/mike';
const now = Date.now();
const minutes = (n) => new Date(now - n * 60_000).toISOString();

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// ------------------------------------------------------------------ demo thread

function demoThread() {
  const id = 'demo_upload_resume';
  const dir = path.join(root, 'demo-upload-resume');
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  writePNG(path.join(dir, 'media/progress-before.png'), 900, 560, drawProgressScreen(0.18, false));
  writePNG(path.join(dir, 'media/progress-after.png'), 900, 560, drawProgressScreen(0.64, true));
  writePNG(path.join(dir, 'media/upload-times.png'), 760, 420, drawChart());

  const events = [];
  let seq = 0;
  let t = 95;
  const push = (turnId, fields) => events.push({ seq: ++seq, ts: minutes((t -= 0.4)), threadId: id, turnId, ...fields });

  // Turn 1
  let turn = 'turn_1';
  push(turn, { type: 'user.message', text: 'Uploads start again from zero if the app quits halfway through. Can you make them resume where they left off? The upload code is in Sources/Upload.', images: [] });
  push(turn, { type: 'turn.started', turnId: turn });
  push(turn, { type: 'reasoning', itemId: 'r1', text: 'Uploads are chunked already, so the missing piece is remembering which chunks the server confirmed. I should look at UploadTask and how it reports progress before changing anything.' });
  push(turn, { type: 'tool.call', itemId: 'c1', name: 'Grep', kind: 'search', title: 'Search for "class UploadTask"', input: { pattern: 'class UploadTask', path: 'Sources' } });
  push(turn, { type: 'tool.result', itemId: 'c1', ok: true, text: 'Sources/Upload/UploadTask.swift:12:final class UploadTask {\nSources/Upload/UploadQueue.swift:4:// UploadTask instances are owned by the queue', truncated: false, images: [] });
  push(turn, { type: 'tool.call', itemId: 'c2', name: 'Read', kind: 'read', title: `Read ~/dev/photo-sync/Sources/Upload/UploadTask.swift`, input: { file_path: `${home}/dev/photo-sync/Sources/Upload/UploadTask.swift` } });
  push(turn, { type: 'tool.result', itemId: 'c2', ok: true, text: uploadTaskSource(), truncated: false, images: [] });
  push(turn, { type: 'assistant.text', itemId: 'm1', text: [
    'Found it. `UploadTask` sends the file in **4 MB chunks**, but it only keeps the offset in memory:',
    '',
    '```swift',
    'private var offset: Int64 = 0   // lost when the app quits',
    '```',
    '',
    'So after a crash the queue rebuilds the task and starts at zero. The server already accepts a `Content-Range`, so resuming is mostly about remembering what it confirmed. Plan:',
    '',
    '1. Keep a small journal per upload with the confirmed offset.',
    '2. Write it after every confirmed chunk, not before.',
    '3. On launch, ask the server for its offset and take the smaller of the two.',
  ].join('\n') });
  push(turn, { type: 'plan.updated', entries: [
    { text: 'Add an upload journal that survives a crash', status: 'completed' },
    { text: 'Resume from the confirmed offset', status: 'in_progress' },
    { text: 'Test a quit halfway through', status: 'pending' },
  ] });
  push(turn, { type: 'tool.call', itemId: 'c3', name: 'Write', kind: 'write', title: 'Write ~/dev/photo-sync/Sources/Upload/UploadJournal.swift', input: { file_path: `${home}/dev/photo-sync/Sources/Upload/UploadJournal.swift`, content: journalSource() } });
  push(turn, { type: 'edit.diff', itemId: 'c3', path: `${home}/dev/photo-sync/Sources/Upload/UploadJournal.swift`, hunks: [allAdded(journalSource())] });
  push(turn, { type: 'tool.result', itemId: 'c3', ok: true, text: 'File created successfully.', truncated: false, images: [] });
  push(turn, { type: 'tool.call', itemId: 'c4', name: 'Edit', kind: 'edit', title: 'Edit ~/dev/photo-sync/Sources/Upload/UploadTask.swift', input: { file_path: `${home}/dev/photo-sync/Sources/Upload/UploadTask.swift`, old_string: '', new_string: '' } });
  push(turn, { type: 'edit.diff', itemId: 'c4', path: `${home}/dev/photo-sync/Sources/Upload/UploadTask.swift`, hunks: [{
    oldStart: 18, oldLines: 9, newStart: 18, newLines: 13, lines: [
      '     let fileURL: URL',
      '     let remoteID: String',
      '-    private var offset: Int64 = 0',
      '+    private let journal: UploadJournal',
      '+    private var offset: Int64 {',
      '+        journal.confirmedOffset(for: remoteID)',
      '+    }',
      ' ',
      '     func sendNextChunk() async throws {',
      '         let chunk = try reader.read(from: offset, length: chunkSize)',
      '         try await client.put(chunk, range: offset..<offset + Int64(chunk.count))',
      '-        offset += Int64(chunk.count)',
      '+        // Only record it once the server has it.',
      '+        journal.confirm(remoteID, offset: offset + Int64(chunk.count))',
      '     }',
    ],
  }] });
  push(turn, { type: 'tool.result', itemId: 'c4', ok: true, text: 'The file has been updated.', truncated: false, images: [] });
  push(turn, { type: 'tool.call', itemId: 'c5', name: 'Bash', kind: 'command', title: 'Run the upload tests', input: { command: 'swift test --filter UploadTests', description: 'Run the upload tests' } });
  push(turn, { type: 'tool.result', itemId: 'c5', ok: true, text: [
    'Building for debugging...',
    '[42/42] Linking PhotoSyncPackageTests',
    'Test Suite \'UploadTests\' started.',
    'Test Case \'UploadTests.testResumesFromJournal\' passed (0.012 seconds).',
    'Test Case \'UploadTests.testServerOffsetWins\' passed (0.004 seconds).',
    'Test Case \'UploadTests.testQuitHalfway\' passed (0.231 seconds).',
    'Executed 14 tests, with 0 failures (0 unexpected) in 0.318 seconds',
  ].join('\n'), truncated: false, images: [] });
  push(turn, { type: 'plan.updated', entries: [
    { text: 'Add an upload journal that survives a crash', status: 'completed' },
    { text: 'Resume from the confirmed offset', status: 'completed' },
    { text: 'Test a quit halfway through', status: 'completed' },
  ] });
  push(turn, { type: 'assistant.text', itemId: 'm2', text: [
    'Uploads now pick up where they stopped. What changed:',
    '',
    '- `UploadJournal` stores the confirmed offset per upload in a small JSON file, written atomically.',
    '- `UploadTask` reads its offset from the journal and only moves it forward after the server confirms a chunk.',
    '- On launch, the queue asks the server for its offset and uses the smaller one, so a half-sent chunk is sent again.',
    '',
    '| Case | Before | After |',
    '|---|---|---|',
    '| Quit at 60% of 1 GB | 1 GB re-sent | 400 MB re-sent |',
    '| Network drop | Restart | Resume |',
    '',
    'All 14 upload tests pass, including a new one that kills the task halfway.',
  ].join('\n') });
  push(turn, { type: 'turn.completed', turnId: turn, outcome: 'completed', durationMs: 134_000, costUsd: 0.38 });

  // Turn 2
  turn = 'turn_2';
  t -= 6;
  push(turn, { type: 'user.message', text: 'Nice. This is what the progress screen looked like before. Can you check it now?', images: [{ path: 'media/progress-before.png', mediaType: 'image/png', width: 900, height: 560 }] });
  push(turn, { type: 'turn.started', turnId: turn });
  push(turn, { type: 'tool.call', itemId: 'c6', name: 'Bash', kind: 'command', title: 'Take a screenshot of the progress screen', input: { command: 'xcrun simctl io booted screenshot /tmp/progress.png', description: 'Take a screenshot of the progress screen' } });
  push(turn, { type: 'tool.result', itemId: 'c6', ok: true, text: 'Wrote screenshot to: /tmp/progress.png', truncated: false, images: [
    { path: 'media/progress-after.png', mediaType: 'image/png', width: 900, height: 560 },
    { path: 'media/upload-times.png', mediaType: 'image/png', width: 760, height: 420 },
  ] });
  push(turn, { type: 'assistant.text', itemId: 'm3', text: 'Here it is after a forced quit at about two thirds. The bar starts at **64%** instead of zero, and the chart shows resumed uploads finishing in roughly a third of the time.' });
  push(turn, { type: 'turn.completed', turnId: turn, outcome: 'completed', durationMs: 21_400, costUsd: 0.06 });

  // Turn 3: waiting on an approval
  turn = 'turn_3';
  t -= 3;
  push(turn, { type: 'user.message', text: 'Great. Clear out the old build folders too, they are taking up space.', images: [] });
  push(turn, { type: 'turn.started', turnId: turn });
  push(turn, { type: 'tool.call', itemId: 'c7', name: 'Bash', kind: 'command', title: 'Check the size of the build folders', input: { command: 'du -sh .build DerivedData', description: 'Check the size of the build folders' } });
  push(turn, { type: 'tool.result', itemId: 'c7', ok: true, text: '2.1G\t.build\n6.4G\tDerivedData', truncated: false, images: [] });
  push(turn, { type: 'approval.requested', approvalId: 'ap1', itemId: 'c8', name: 'Bash', title: 'rm -rf .build DerivedData', input: { command: 'rm -rf .build DerivedData' }, options: ['allow', 'allowAlways', 'deny'] });

  const summary = {
    id, title: 'Make uploads resume after a crash', cwd: `${home}/dev/photo-sync`, accountId: 'claude-main', provider: 'claude',
    permissionMode: 'ask', status: 'waiting', live: true, needsYou: true,
    createdAt: minutes(96), updatedAt: minutes(1), lastActivityAt: minutes(1),
    preview: 'Here it is after a forced quit at about two thirds.', lastSeq: seq, lastSeenSeq: seq - 4, costUsd: 0.44,
    contextTokens: 642_300, contextWindow: 1_000_000,
  };
  writeFixture(dir, summary, events);
}

// ------------------------------------------------------------------ other threads

function smallThread({ name, title, minutesAgo, status = 'idle', needsYou = false, unread = needsYou, accountId = 'claude-main', snoozedHours, archivedMinutes, background, turns }) {
  const id = `demo_${name.replace(/-/g, '_')}`;
  const dir = path.join(root, `demo-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const events = [];
  let seq = 0;
  turns.forEach((turn, index) => {
    const turnId = `turn_${index + 1}`;
    const ts = minutes(minutesAgo + (turns.length - index) * 5);
    events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'user.message', text: turn.user, images: [] });
    events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'turn.started', turnId });
    for (const tool of turn.tools ?? []) {
      events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'tool.call', itemId: `${turnId}_${tool.id}`, name: tool.name, kind: tool.kind, title: tool.title, input: tool.input ?? {} });
      events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'tool.result', itemId: `${turnId}_${tool.id}`, ok: tool.ok ?? true, text: tool.output ?? '', truncated: false, images: [] });
    }
    if (turn.question) {
      events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'question.requested', approvalId: `${turnId}_q`, questions: turn.question });
      return;
    }
    // An ask_secret card (docs/protocol.md, "Secrets"), still waiting.
    if (turn.secret) {
      events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'secret.requested', approvalId: `${turnId}_secret`, itemId: `${turnId}_ask`, ...turn.secret });
      return;
    }
    events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'assistant.text', itemId: `${turnId}_m`, text: turn.reply });
    // What the turn said it needs from Mike (docs/protocol.md, "Needs you").
    const said = turn.needs ? { needs: turn.needs, ...(turn.asks ? { asks: turn.asks } : {}), ...(turn.next ? { next: turn.next } : {}), needsFrom: 'tool' } : {};
    events.push({ seq: ++seq, ts, threadId: id, turnId, type: 'turn.completed', turnId, outcome: 'completed', durationMs: turn.ms ?? 18_000, costUsd: turn.cost ?? 0.05, ...said });
  });
  const last = [...events].reverse().find((e) => e.type === 'assistant.text');
  const lastDone = [...events].reverse().find((e) => e.type === 'turn.completed');
  const summary = {
    id, title, cwd: `${home}/dev/me/misc`, accountId, provider: 'claude', permissionMode: 'full', status, live: false, needsYou,
    createdAt: minutes(minutesAgo + 60), updatedAt: minutes(minutesAgo), lastActivityAt: minutes(minutesAgo),
    preview: last ? last.text.replace(/\s+/g, ' ').slice(0, 140) : '', lastSeq: seq, lastSeenSeq: unread ? seq - 1 : seq,
    ...(lastDone?.needs ? { needs: lastDone.needs } : {}),
    ...(lastDone?.asks ? { asks: lastDone.asks, asksSeq: lastDone.seq } : {}),
    ...(snoozedHours ? { snoozedUntil: new Date(now + snoozedHours * 3_600_000).toISOString() } : {}),
    ...(archivedMinutes ? { archivedAt: minutes(archivedMinutes) } : {}),
    ...(background ? { background } : {}),
  };
  writeFixture(dir, summary, events);
}

function others() {
  smallThread({ name: 'release-notes', title: 'Draft the release notes for 0.4', minutesAgo: 4, needsYou: true, turns: [
    { user: 'Draft release notes for 0.4 from the merged PRs since 0.3.', tools: [{ id: 'gh', name: 'Bash', kind: 'command', title: 'List merged PRs since v0.3', output: '#41 Resume uploads after a crash\n#43 Faster thumbnail grid\n#44 Fix the dark mode toolbar' }],
      reply: '## 0.4\n\n- **Uploads resume** after the app quits or the network drops.\n- The thumbnail grid scrolls faster with large libraries.\n- The toolbar reads properly in dark mode.\n\nWant a shorter version for the App Store?' },
  ] });
  smallThread({ name: 'button-colour', title: 'Pick a colour for the new Share button', minutesAgo: 12, status: 'waiting', needsYou: true, turns: [
    { user: 'Add a Share button to the photo viewer toolbar.', tools: [{ id: 'read', name: 'Read', kind: 'read', title: 'Read ~/dev/photo-sync/Sources/Viewer/Toolbar.swift', input: { file_path: `${home}/dev/photo-sync/Sources/Viewer/Toolbar.swift` }, output: 'struct Toolbar: View { ... }' }],
      question: [{ question: 'Which colour should the Share button be?', header: 'Colour', multiSelect: false, options: [
        { label: 'Accent blue', description: 'Matches the other toolbar buttons' }, { label: 'Green', description: 'Stands out as the main action' }, { label: 'Plain grey' }] }] },
  ] });
  smallThread({ name: 'keep-awake', title: 'Stop Keep Awake asking for my password', minutesAgo: 9, status: 'waiting', needsYou: true, turns: [
    { user: 'My Raycast Keep Awake toggle asks for my password every time. Can you make it stop asking?', tools: [{ id: 'read', name: 'Read', kind: 'read', title: 'Read ~/dev/me/raycast-scripts/keep-awake.sh', input: { file_path: `${home}/dev/me/raycast-scripts/keep-awake.sh` }, output: 'sudo pmset -a disablesleep "$1"' }],
      secret: { label: 'Mac administrator password', reason: 'Install the Keep Awake rule that allows only the two fixed pmset sleep-toggle commands, so Raycast toggles work without repeated prompts.' } },
  ] });
  runningThread();
  // A turn that ended with three sub-agents still going: the sidebar's
  // "3 sub-agents" row and the transcript's background line.
  smallThread({ name: 'landing-pages', title: 'Rebuild the three landing pages', minutesAgo: 6, background: [
    { kind: 'agent', description: 'Rebuild the home page' },
    { kind: 'agent', description: 'Rebuild the pricing page' },
    { kind: 'agent', description: 'Rebuild the docs page' },
  ], turns: [
    { user: 'Rebuild the home, pricing and docs landing pages with the new design. One sub-agent each, in the background, and tell me as each one lands.',
      tools: [
        { id: 'a1', name: 'Agent', kind: 'task', title: 'Rebuild the home page', input: { description: 'Rebuild the home page', run_in_background: true }, output: 'Started in the background (agent a1).' },
        { id: 'a2', name: 'Agent', kind: 'task', title: 'Rebuild the pricing page', input: { description: 'Rebuild the pricing page', run_in_background: true }, output: 'Started in the background (agent a2).' },
        { id: 'a3', name: 'Agent', kind: 'task', title: 'Rebuild the docs page', input: { description: 'Rebuild the docs page', run_in_background: true }, output: 'Started in the background (agent a3).' },
      ],
      reply: 'Three sub-agents are on it, one page each. I\'ll come back here as each one finishes.', ms: 9_000, cost: 0.03 },
  ] });
  // Needs you: a turn that ended with end_turn's asks, as a checklist.
  smallThread({ name: 'testflight-beta', title: 'Ship the beta to TestFlight', minutesAgo: 2, needsYou: true, turns: [
    { user: 'Get build 42 of the iPhone app out to the beta testers.', tools: [{ id: 't', name: 'Bash', kind: 'command', title: 'xcodebuild archive', output: '** ARCHIVE SUCCEEDED **' }],
      reply: 'Build 42 is archived and signed, with the release notes written from this week\'s commits.\n\nThe upload stopped at App Store Connect: there\'s a new agreement to accept, and only the account holder can.',
      needs: 'you', asks: [
        { action: 'Accept the new agreement in App Store Connect', where: 'App Store Connect › Business', reply: 'done' },
        { action: 'Check who gets the beta', why: 'My picks are in brackets:\n- Just the internal testers first? (yes)\n- Send the external group a day later? (yes)' },
      ] },
  ] });
  // Done: finished, unread, and it said nothing waits on Mike, so it's in
  // the inbox with a tick rather than in Needs you.
  smallThread({ name: 'tidy-imports', title: 'Tidy the imports in the uploader', minutesAgo: 9, unread: true, turns: [
    { user: 'Tidy the imports in the uploader.', reply: 'Sorted and de-duplicated the imports in all six files. The build and tests pass.', needs: 'nothing', next: ['Turn on the lint rule that sorts imports'], ms: 31_000, cost: 0.04 },
  ] });
  smallThread({ name: 'settings-tabs', title: 'Rename the Settings tabs', minutesAgo: 47, turns: [
    { user: 'Rename the Settings tabs to General, Sync and Advanced.', tools: [{ id: 'e', name: 'Edit', kind: 'edit', title: 'Edit ~/dev/photo-sync/Sources/Settings/SettingsView.swift', input: { file_path: `${home}/dev/photo-sync/Sources/Settings/SettingsView.swift`, old_string: 'Tab("Prefs")', new_string: 'Tab("General")' } }], reply: 'Done. The tabs now read **General**, **Sync** and **Advanced**.' },
  ] });
  smallThread({ name: 'sqlite-vs-files', title: 'Compare SQLite and plain files for the runner', minutesAgo: 180, accountId: 'claude-3', turns: [
    { user: 'For the runner, should events go in SQLite or plain NDJSON files?', reply: 'Plain files win here:\n\n1. Events are append-only, which is what NDJSON is good at.\n2. Each thread is read whole or from the end, never queried.\n3. `node:sqlite` truncates text at NUL on Node 24.\n\nSQLite would earn its keep only if you needed search across threads.' },
  ] });
  smallThread({ name: 'dark-mode', title: 'Add dark mode to the dashboard', minutesAgo: 60 * 26, turns: [
    { user: 'Add dark mode to the dashboard.', reply: 'Added. Colours come from the asset catalogue, so they follow the system setting.' },
  ] });
  smallThread({ name: 'tunnel', title: 'Set up the Cloudflare tunnel for the preview server', minutesAgo: 60 * 50, archivedMinutes: 60 * 49, turns: [
    { user: 'Set up a Cloudflare tunnel for the preview server.', reply: 'The tunnel is running as a LaunchAgent and forwards preview.example.com to port 4321.' },
  ] });
  smallThread({ name: 'quick-ask-readme', title: 'Write the Quick Ask README', minutesAgo: 60 * 30, archivedMinutes: 60 * 28, turns: [
    { user: 'Write a README for Quick Ask.', reply: 'Wrote README.md with install steps, the hotkey and how to pick a model.' },
  ] });
  smallThread({ name: 'invoice-export', title: 'Export last quarter\'s invoices as CSV', minutesAgo: 60 * 3, snoozedHours: 18, turns: [
    { user: 'Export last quarter\'s invoices as CSV.', reply: 'The export is ready, but two invoices have no client name. Shall I fill those in from the PDFs?' },
  ] });
}

// A turn that's still running: some work, a short reply, then more work
// with the last command still going. The mock runner moves its start to a
// few seconds before it loads, so "Working for" reads as a live turn.
function runningThread() {
  const id = 'demo_ci_slow';
  const dir = path.join(root, 'demo-ci-slow');
  fs.mkdirSync(dir, { recursive: true });
  const turnId = 'turn_1';
  const ts = minutes(1);
  const events = [];
  let seq = 0;
  const push = (fields) => events.push({ seq: ++seq, ts, threadId: id, turnId, ...fields });
  push({ type: 'user.message', text: 'The CI build went from 6 to 14 minutes this week. Can you find out why?', images: [] });
  push({ type: 'turn.started', turnId });
  push({ type: 'tool.call', itemId: 'log', name: 'Bash', kind: 'command', title: 'Download the last two CI logs', input: { command: 'gh run download 812 845 --name logs', description: 'Download the last two CI logs' } });
  push({ type: 'tool.result', itemId: 'log', ok: true, text: 'saved run-812.log\nsaved run-845.log', truncated: false, images: [] });
  push({ type: 'assistant.text', itemId: 'm1', text: 'Looking at the two logs now.' });
  push({ type: 'reasoning', itemId: 'r1', text: 'The slower run spends most of its extra time before the build starts, so the cache restore is the first thing to compare.' });
  push({ type: 'tool.call', itemId: 'read1', name: 'Read', kind: 'read', title: 'Read run-812.log', input: { file_path: `${home}/dev/photo-sync/run-812.log` } });
  push({ type: 'tool.result', itemId: 'read1', ok: true, text: 'Restoring cache... done in 41s\nBuilding... done in 4m 52s', truncated: false, images: [] });
  push({ type: 'tool.call', itemId: 'read2', name: 'Read', kind: 'read', title: 'Read run-845.log', input: { file_path: `${home}/dev/photo-sync/run-845.log` } });
  push({ type: 'tool.result', itemId: 'read2', ok: true, text: 'Restoring cache... miss\nBuilding... done in 13m 10s', truncated: false, images: [] });
  push({ type: 'tool.call', itemId: 'cmp', name: 'Bash', kind: 'command', title: 'Compare the cache keys', input: { command: 'grep "cache key" run-812.log run-845.log', description: 'Compare the cache keys' } });
  const summary = {
    id, title: 'Why is the build slow on CI?', cwd: `${home}/dev/me/misc`, accountId: 'claude-main', provider: 'claude', permissionMode: 'full',
    status: 'running', live: false, needsYou: false, createdAt: minutes(61), updatedAt: minutes(1), lastActivityAt: minutes(1),
    preview: 'Looking at the two logs now.', lastSeq: seq, lastSeenSeq: seq,
  };
  writeFixture(dir, summary, events);
}

// The tool and card states the other threads don't have, for the design
// screenshots: a command and a key/value tool opened, a failed tool inside a
// group, a Write approval and a question that have both been answered.
// Archived, so the inbox shots stay as they are.
function toolDetailsThread() {
  const id = 'demo_build_scripts';
  const dir = path.join(root, 'demo-build-scripts');
  fs.mkdirSync(dir, { recursive: true });
  const turnId = 'turn_1';
  const events = [];
  let seq = 0;
  let t = 60 * 40;
  const push = (fields) => events.push({ seq: ++seq, ts: minutes((t -= 0.3)), threadId: id, turnId, ...fields });
  const script = `${home}/dev/photo-sync/scripts/release.sh`;
  const scriptSource = [
    '#!/usr/bin/env bash',
    '# Builds a signed release and zips it for upload.',
    'set -euo pipefail',
    '',
    'swift build -c release',
    'codesign --sign "$SIGNING_IDENTITY" --options runtime .build/release/PhotoSync',
    'ditto -c -k --keepParent .build/release/PhotoSync PhotoSync.zip',
    '',
  ].join('\n');
  push({ type: 'user.message', text: 'Tidy up the build scripts and check the release build still works.', images: [] });
  push({ type: 'turn.started', turnId });
  push({ type: 'tool.call', itemId: 'ls', name: 'Bash', kind: 'command', title: 'List the build scripts', input: { command: 'ls -l scripts/', description: 'List the build scripts' } });
  push({ type: 'tool.result', itemId: 'ls', ok: true, text: [
    'total 24',
    '-rwxr-xr-x  1 mike  staff   412 Oct 12 09:14 build.sh',
    '-rwxr-xr-x  1 mike  staff   398 Oct 12 09:14 build-old.sh',
    '-rwxr-xr-x  1 mike  staff   655 Oct 20 17:02 release.sh',
  ].join('\n'), truncated: false, images: [] });
  push({ type: 'tool.call', itemId: 'pr', name: 'mcp__github__get_pull_request', kind: 'mcp', title: 'Get pull request #48',
    input: { owner: 'mike', repo: 'photo-sync', pullNumber: 48 } });
  push({ type: 'tool.result', itemId: 'pr', ok: true, text: '#48 Move signing into release.sh (merged 20 Oct)\nFiles: scripts/release.sh, scripts/build-old.sh', truncated: false, images: [] });
  push({ type: 'tool.call', itemId: 'rel', name: 'Bash', kind: 'command', title: 'Run the release build', input: { command: './scripts/release.sh', description: 'Run the release build' } });
  push({ type: 'tool.result', itemId: 'rel', ok: false, text: 'Building for production...\nerror: SIGNING_IDENTITY is not set', truncated: false, images: [] });
  // In the runner's order: the call, then the approval it waits on, then its result.
  push({ type: 'tool.call', itemId: 'w', name: 'Write', kind: 'write', title: `Write ${script}`, input: { file_path: script, content: scriptSource } });
  push({ type: 'approval.requested', approvalId: 'ap_w', itemId: 'w', name: 'Write', title: `Write ${script}`, input: { file_path: script, content: scriptSource }, options: ['allow', 'allowAlways', 'deny'] });
  push({ type: 'approval.resolved', approvalId: 'ap_w', decision: 'allow' });
  push({ type: 'tool.result', itemId: 'w', ok: true, text: 'File written.', truncated: false, images: [] });
  push({ type: 'question.requested', approvalId: 'q_old', questions: [{ question: 'build-old.sh isn\'t used anywhere. Delete it?', header: 'Old script', multiSelect: false, options: [
    { label: 'Delete it' }, { label: 'Keep it', description: 'Leave it for now' }] }] });
  push({ type: 'approval.resolved', approvalId: 'q_old', decision: 'answered', message: 'Keep it for now, I still use it for beta builds.' });
  push({ type: 'assistant.text', itemId: 'm1', text: 'The release script now reads the signing identity from `SIGNING_IDENTITY` and stops with a clear error when it is missing. I kept `build-old.sh` as you asked.' });
  push({ type: 'turn.completed', turnId, outcome: 'completed', durationMs: 48_000, costUsd: 0.09 });
  const summary = {
    id, title: 'Tidy up the build scripts', cwd: `${home}/dev/photo-sync`, accountId: 'claude-main', provider: 'claude', permissionMode: 'ask',
    status: 'idle', live: false, needsYou: false, createdAt: minutes(60 * 41), updatedAt: minutes(60 * 40), lastActivityAt: minutes(60 * 40),
    archivedAt: minutes(60 * 39), preview: 'The release script now reads the signing identity from SIGNING_IDENTITY.', lastSeq: seq, lastSeenSeq: seq,
  };
  writeFixture(dir, summary, events);
}

// A Codex thread: what the Codex adapter sends (docs/step4-plan.md,
// section B). One edit touching three files, a plan, a generated image, an
// image Codex looked at, a subagent with its own image, a command left
// running in the background that finishes after the turn, an interrupted
// command and a turn that hit the usage limit. Codex turns have tokens but
// no cost.
function codexThread() {
  const id = 'demo_codex_poster';
  const dir = path.join(root, 'demo-codex-poster');
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  const poster = { w: 512, h: 512 };
  const map = { w: 640, h: 400 };
  const palette = { w: 384, h: 384 };
  writePNG(path.join(dir, 'media/poster.png'), poster.w, poster.h, drawPoster());
  writePNG(path.join(dir, 'media/venue-map.png'), map.w, map.h, drawVenueMap());
  writePNG(path.join(dir, 'media/palette.png'), palette.w, palette.h, drawPalette());
  const site = `${home}/dev/meetup-site`;

  const events = [];
  let seq = 0;
  let t = 8.5;
  const push = (turnId, fields) => events.push({ seq: ++seq, ts: minutes((t -= 0.15)), threadId: id, ...(turnId ? { turnId } : {}), ...fields });
  const image = (file, size) => ({ path: `media/${file}`, mediaType: 'image/png', width: size.w, height: size.h });

  // Turn 1
  let turn = 'turn_1';
  push(turn, { type: 'user.message', text: 'Make a poster for the November meetup and put it on the events page. The venue map is in docs/.', images: [] });
  push(turn, { type: 'turn.started', turnId: turn });
  push(turn, { type: 'reasoning', itemId: 'rs_1', text: '**Looking at the site**\n\nThe events page lists each meetup from a data file, so the poster needs an entry there, an image tag in the page and a style for it.' });
  push(turn, { type: 'tool.call', itemId: 'call_ls', name: 'shell', kind: 'read', title: 'ls src/pages src/data', input: { command: 'ls src/pages src/data', cwd: site } });
  push(turn, { type: 'tool.result', itemId: 'call_ls', ok: true, text: 'src/data:\nevents.json\n\nsrc/pages:\nevents.html\nindex.html\nstyles.css', truncated: false, images: [] });
  push(turn, { type: 'plan.updated', entries: [
    { text: 'Look at the events page', status: 'completed' },
    { text: 'Add the November meetup with a poster', status: 'in_progress' },
    { text: 'Make the poster', status: 'pending' },
  ] });
  const paths = [`${site}/src/data/events.json`, `${site}/src/pages/events.html`, `${site}/src/pages/styles.css`];
  push(turn, { type: 'tool.call', itemId: 'call_patch', name: 'apply_patch', kind: 'edit', title: 'Edit 3 files', input: { paths } });
  push(turn, { type: 'edit.diff', itemId: 'call_patch', path: paths[0], hunks: [{
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 9, lines: [
      ' [',
      '+  {',
      '+    "title": "November meetup",',
      '+    "date": "2026-11-19",',
      '+    "poster": "posters/november.png"',
      '+  },',
      '   {',
      '     "title": "October meetup",',
    ] }] });
  push(turn, { type: 'edit.diff', itemId: 'call_patch', path: paths[1], hunks: [{
    oldStart: 12, oldLines: 3, newStart: 12, newLines: 4, lines: [
      '   <article class="event">',
      '     <h2>{{ title }}</h2>',
      '+    <img class="poster" src="{{ poster }}" alt="Poster for {{ title }}">',
      '     <time>{{ date }}</time>',
    ] }] });
  push(turn, { type: 'edit.diff', itemId: 'call_patch', path: paths[2], hunks: [{
    oldStart: 40, oldLines: 2, newStart: 40, newLines: 6, lines: [
      ' .event time { color: var(--muted); }',
      '+.event .poster {',
      '+  width: 100%;',
      '+}',
      ' ',
    ] }] });
  // Codex's patchUpdated: the same path again replaces its earlier diff.
  push(turn, { type: 'edit.diff', itemId: 'call_patch', path: paths[2], hunks: [{
    oldStart: 40, oldLines: 2, newStart: 40, newLines: 7, lines: [
      ' .event time { color: var(--muted); }',
      '+.event .poster {',
      '+  width: 100%;',
      '+  border-radius: 12px;',
      '+}',
      ' ',
    ] }] });
  push(turn, { type: 'tool.result', itemId: 'call_patch', ok: true, text: 'Success. Updated the following files:\nM src/data/events.json\nM src/pages/events.html\nM src/pages/styles.css', truncated: false, images: [] });
  push(turn, { type: 'tool.call', itemId: 'call_map', name: 'view_image', kind: 'read', title: 'View docs/venue-map.png', input: { path: `${site}/docs/venue-map.png` } });
  push(turn, { type: 'tool.result', itemId: 'call_map', ok: true, text: '', truncated: false, images: [image('venue-map.png', map)] });
  push(turn, { type: 'tool.call', itemId: 'ig_1', name: 'image_generation', kind: 'image', title: 'Generate image', input: {} });
  push(turn, { type: 'tool.result', itemId: 'ig_1', ok: true, text: 'A bold square poster for a November developer meetup: a deep blue background, an orange sun rising over three stacked rounded shapes, and space at the top for the date.', truncated: false, images: [image('poster.png', poster)] });
  push(turn, { type: 'plan.updated', entries: [
    { text: 'Look at the events page', status: 'completed' },
    { text: 'Add the November meetup with a poster', status: 'completed' },
    { text: 'Make the poster', status: 'in_progress' },
  ] });
  const child = '019a3c2e-child';
  push(turn, { type: 'tool.call', itemId: 'sa_1', name: 'spawn_agent', kind: 'task', title: 'poster_colours', input: { model: 'gpt-6-luna' } });
  push(turn, { type: 'tool.call', itemId: `${child}/ig_2`, name: 'image_generation', kind: 'image', title: 'Generate image', input: {} });
  push(turn, { type: 'tool.result', itemId: `${child}/ig_2`, ok: true, text: 'A palette card with four swatches: deep blue, orange, cream and slate.', truncated: false, images: [image('palette.png', palette)] });
  push(turn, { type: 'tool.result', itemId: 'sa_1', ok: true, text: 'The poster\'s blue and orange pass contrast on the cream page background. I made a palette card with the four colours.', truncated: false, images: [] });
  push(turn, { type: 'tool.call', itemId: 'call_build', name: 'shell', kind: 'command', title: 'npm run build', input: { command: 'npm run build', cwd: site } });
  push(turn, { type: 'assistant.text', itemId: 'msg_1', text: 'The November meetup is on the events page with its poster, and the build is still running in the background. The poster is in `public/posters/november.png`.' });
  push(turn, { type: 'turn.completed', turnId: turn, outcome: 'completed', durationMs: 48_200,
    usage: { inputTokens: 38_412, cachedInputTokens: 29_184, outputTokens: 2_906, reasoningTokens: 1_120 } });
  // The build Codex left running ends after the turn: its result has no turn.
  push(undefined, { type: 'tool.result', itemId: 'call_build', ok: true, text: '> meetup-site@1.4.0 build\n> vite build\n\nbuilt 14 pages in 8.1s', truncated: false, images: [] });

  // Turn 2: stopped while the tests ran.
  turn = 'turn_2';
  push(turn, { type: 'user.message', text: 'Run the tests too', images: [] });
  push(turn, { type: 'turn.started', turnId: turn });
  push(turn, { type: 'tool.call', itemId: 'call_test', name: 'shell', kind: 'command', title: 'npm test', input: { command: 'npm test', cwd: site } });
  push(turn, { type: 'tool.result', itemId: 'call_test', ok: false, text: 'Interrupted', truncated: false, images: [] });
  push(turn, { type: 'turn.completed', turnId: turn, outcome: 'interrupted', durationMs: 9_300,
    usage: { inputTokens: 41_020, cachedInputTokens: 38_016, outputTokens: 212, reasoningTokens: 64 } });

  // Turn 3: the account hit its limit.
  turn = 'turn_3';
  const limit = 'You\'ve hit your usage limit. Try again at 3:40 pm.';
  push(turn, { type: 'user.message', text: 'Try the tests again without watch mode.', images: [] });
  push(turn, { type: 'turn.started', turnId: turn });
  push(turn, { type: 'error', message: limit });
  push(turn, { type: 'turn.completed', turnId: turn, outcome: 'failed', durationMs: 1_200, error: limit, errorKind: 'usageLimit' });

  const summary = {
    id, title: 'Make a poster for the meetup', cwd: site, accountId: 'codex-main', provider: 'codex',
    model: 'gpt-6.1-sol', effort: 'high', modelInUse: 'gpt-6.1-sol', effortInUse: 'high',
    permissionMode: 'full', status: 'error', live: false, needsYou: false,
    createdAt: minutes(13), updatedAt: minutes(3), lastActivityAt: minutes(3),
    preview: limit, lastSeq: seq, lastSeenSeq: seq, contextTokens: 41_020, contextWindow: 475_000,
  };
  writeFixture(dir, summary, events);
}

// ------------------------------------------------------------------ helpers

function writeFixture(dir, summary, events) {
  fs.writeFileSync(path.join(dir, 'thread.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function allAdded(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) };
}

function uploadTaskSource() {
  return `import Foundation

/// Sends one file to the server in fixed-size chunks.
final class UploadTask {
    let fileURL: URL
    let remoteID: String
    private var offset: Int64 = 0
    private let chunkSize = 4 * 1024 * 1024

    func sendNextChunk() async throws {
        let chunk = try reader.read(from: offset, length: chunkSize)
        try await client.put(chunk, range: offset..<offset + Int64(chunk.count))
        offset += Int64(chunk.count)
    }
}`;
}

function journalSource() {
  return `import Foundation

/// Remembers how much of each upload the server has confirmed, so an upload
/// can resume after the app quits.
final class UploadJournal {
    private var offsets: [String: Int64] = [:]
    private let url: URL

    init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url) {
            offsets = (try? JSONDecoder().decode([String: Int64].self, from: data)) ?? [:]
        }
    }

    func confirmedOffset(for id: String) -> Int64 {
        offsets[id] ?? 0
    }

    func confirm(_ id: String, offset: Int64) {
        offsets[id] = max(offsets[id] ?? 0, offset)
        try? JSONEncoder().encode(offsets).write(to: url, options: .atomic)
    }
}
`;
}

// Tiny raster drawing and PNG encoding, so the demo has real image files.

function canvas(width, height, background) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(background, i * 4);
  const fill = (x0, y0, w, h, color, radius = 0) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        if (radius) {
          const cx = x < x0 + radius ? x0 + radius : x >= x0 + w - radius ? x0 + w - radius - 1 : x;
          const cy = y < y0 + radius ? y0 + radius : y >= y0 + h - radius ? y0 + h - radius - 1 : y;
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
        }
        pixels.set(color, (y * width + x) * 4);
      }
    }
  };
  return { pixels, fill, width, height };
}

function drawProgressScreen(progress, resumed) {
  return (c) => {
    const white = [255, 255, 255, 255];
    c.fill(0, 0, c.width, 64, [246, 246, 248, 255]);
    c.fill(24, 24, 180, 16, [60, 60, 67, 255], 6);
    c.fill(60, 120, 780, 320, white, 18);
    c.fill(100, 160, 300, 22, [40, 40, 45, 255], 8);
    c.fill(100, 196, 460, 14, [160, 160, 168, 255], 6);
    c.fill(100, 260, 700, 26, [228, 228, 234, 255], 13);
    c.fill(100, 260, Math.round(700 * progress), 26, resumed ? [52, 120, 246, 255] : [255, 149, 0, 255], 13);
    c.fill(100, 310, 120, 14, [160, 160, 168, 255], 6);
    c.fill(680, 310, 120, 14, [160, 160, 168, 255], 6);
    c.fill(100, 370, 160, 40, resumed ? [52, 120, 246, 255] : [200, 200, 205, 255], 10);
  };
}

function drawChart() {
  return (c) => {
    c.fill(60, 360, 660, 2, [200, 200, 205, 255]);
    const before = [300, 280, 310, 295, 305];
    const after = [110, 96, 120, 102, 99];
    before.forEach((h, i) => {
      const x = 90 + i * 125;
      c.fill(x, 360 - h, 40, h, [255, 149, 0, 255], 4);
      c.fill(x + 46, 360 - after[i], 40, after[i], [52, 120, 246, 255], 4);
    });
    c.fill(80, 30, 24, 14, [255, 149, 0, 255], 3);
    c.fill(112, 32, 120, 10, [120, 120, 128, 255], 4);
    c.fill(260, 30, 24, 14, [52, 120, 246, 255], 3);
    c.fill(292, 32, 120, 10, [120, 120, 128, 255], 4);
  };
}

function drawPoster() {
  return (c) => {
    c.fill(0, 0, c.width, c.height, [28, 44, 92, 255]);
    c.fill(196, 150, 120, 120, [255, 149, 0, 255], 60);
    c.fill(96, 290, 320, 46, [240, 232, 214, 255], 23);
    c.fill(126, 350, 260, 46, [214, 120, 60, 255], 23);
    c.fill(156, 410, 200, 46, [96, 112, 140, 255], 23);
    c.fill(56, 48, 220, 26, [240, 232, 214, 255], 8);
    c.fill(56, 86, 140, 14, [150, 164, 196, 255], 6);
  };
}

function drawVenueMap() {
  return (c) => {
    c.fill(0, 0, c.width, c.height, [236, 238, 232, 255]);
    c.fill(0, 180, c.width, 30, [255, 255, 255, 255]);
    c.fill(300, 0, 26, c.height, [255, 255, 255, 255]);
    c.fill(60, 40, 200, 110, [214, 224, 206, 255], 10);
    c.fill(360, 240, 220, 120, [208, 214, 226, 255], 10);
    c.fill(420, 270, 40, 40, [214, 60, 50, 255], 20);
    c.fill(60, 250, 180, 90, [226, 220, 208, 255], 10);
  };
}

function drawPalette() {
  return (c) => {
    c.fill(0, 0, c.width, c.height, [250, 248, 242, 255]);
    const swatches = [[28, 44, 92, 255], [255, 149, 0, 255], [240, 232, 214, 255], [96, 112, 140, 255]];
    swatches.forEach((color, i) => c.fill(32 + (i % 2) * 168, 32 + Math.floor(i / 2) * 168, 152, 152, color, 14));
  };
}

function writePNG(file, width, height, draw) {
  const c = canvas(width, height, [250, 250, 252, 255]);
  draw(c);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    c.pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

demoThread();
others();
toolDetailsThread();
codexThread();
console.log(`wrote ${fs.readdirSync(root).length} demo threads to ${root}`);
