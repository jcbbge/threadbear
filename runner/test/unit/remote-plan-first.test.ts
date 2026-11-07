// Daybreak, 7 Nov 2026: "Remote Plan first threads silently start with full
// access". Three hops each kept only ask, full and auto (relay.ts on the
// main Mac, convex/relay.ts, the other runner's sync.ts), and a create with
// no mode starts on full access. Each hop now keeps every mode and refuses
// one it doesn't know; Plan first goes as Ask with plan: true, so a hop from
// before it starts the thread on Ask, never full. relay.test.ts and
// sync.test.ts have the runner hops; this is the backend's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../helpers/convex-memory.ts';
import { remoteCreateMode, remoteCreateModeOf } from '../../src/protocol.ts';

const { commandArgs } = load('relay') as { commandArgs: (kind: string, a: unknown) => Record<string, unknown> };

test('the backend keeps every mode of a create, Plan first included, and refuses an unknown one', () => {
  for (const mode of ['full', 'ask', 'auto', 'plan'] as const) assert.equal(commandArgs('create', { text: 'go', permissionMode: mode }).permissionMode, mode);
  assert.deepEqual(commandArgs('create', { text: 'go', ...remoteCreateMode('plan') }), { text: 'go', permissionMode: 'ask', plan: true });
  assert.equal('permissionMode' in commandArgs('create', { text: 'go' }), false);
  assert.throws(() => commandArgs('create', { text: 'go', permissionMode: 'yolo' }), /permissionMode must be one of/);
  // The flag only ever narrows Ask; it can't ride on another mode.
  assert.throws(() => commandArgs('create', { text: 'go', permissionMode: 'full', plan: true }), /plan: true goes with/);
  assert.throws(() => commandArgs('create', { text: 'go', permissionMode: 'ask', plan: 'yes' }), /plan: true goes with/);
});

test('the wire form round-trips every mode, and a receiver refuses one it cannot read', () => {
  for (const mode of ['full', 'ask', 'auto', 'plan'] as const) assert.equal(remoteCreateModeOf(remoteCreateMode(mode)), mode);
  assert.equal(remoteCreateModeOf({ permissionMode: 'plan' }), 'plan');
  assert.equal(remoteCreateModeOf({}), undefined);
  assert.throws(() => remoteCreateModeOf({ permissionMode: 'yolo' }), /Unknown permission mode/);
  assert.throws(() => remoteCreateMode('yolo'), /permissionMode must be one of/);
});
