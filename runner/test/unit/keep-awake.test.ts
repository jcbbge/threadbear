// Keeping the Mac awake while threads work (experiment keepAwake,
// src/keep-awake.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { KeepAwake, LINGER_MS, SWEEP_MS, parsePower, type Power } from '../../src/keep-awake.ts';

function setup(o: { on?: boolean; power?: Power } = {}) {
  const clock = new FakeClock();
  const state = { busy: 0, on: o.on ?? true, held: 0, stopped: 0, power: o.power };
  const k = new KeepAwake({
    busy: () => state.busy,
    on: () => state.on,
    clock,
    log: nullLogger,
    hold: () => {
      state.held++;
      return { stop: () => void state.stopped++ };
    },
    power: async () => state.power,
  });
  k.start();
  return { clock, state, k };
}

const flush = () => new Promise((r) => setImmediate(r));

test('keepAwake: holds while a thread works, lingers a few minutes, then lets go', () => {
  const { clock, state, k } = setup();
  assert.equal(k.status().holding, false);
  state.busy = 1;
  clock.advance(SWEEP_MS);
  assert.equal(k.status().holding, true);
  clock.advance(SWEEP_MS * 4);
  assert.equal(state.held, 1, 'one caffeinate for the whole run, not one per sweep');
  state.busy = 0;
  clock.advance(LINGER_MS - SWEEP_MS);
  assert.equal(k.status().holding, true, 'still awake just after the turn ends');
  clock.advance(SWEEP_MS * 2);
  assert.equal(k.status().holding, false);
  assert.equal(state.stopped, 1);
});

test('keepAwake: does nothing with the experiment off, and lets go when it is turned off', () => {
  const { clock, state, k } = setup({ on: false });
  state.busy = 2;
  clock.advance(SWEEP_MS);
  assert.equal(state.held, 0);
  state.on = true;
  clock.advance(SWEEP_MS);
  assert.equal(k.status().holding, true);
  state.on = false;
  clock.advance(SWEEP_MS);
  assert.equal(k.status().holding, false);
});

test('keepAwake: lets go on a low battery, but not on power', async () => {
  const { clock, state, k } = setup({ power: { onBattery: true, percent: 9 } });
  state.busy = 1;
  clock.advance(SWEEP_MS);
  await flush();
  assert.equal(k.status().holding, false, 'released once the battery was read');
  clock.advance(SWEEP_MS);
  assert.equal(k.status().holding, false, 'and not taken again while it is low');
  state.power = { onBattery: false, percent: 9 };
  clock.advance(5 * 60_000);
  await flush();
  clock.advance(SWEEP_MS);
  assert.equal(k.status().holding, true);
});

test('keepAwake: stop lets go', () => {
  const { clock, state, k } = setup();
  state.busy = 1;
  clock.advance(SWEEP_MS);
  k.stop();
  assert.equal(k.status().holding, false);
  assert.equal(clock.pending(), 0);
});

test('keepAwake: reads pmset -g batt', () => {
  assert.deepEqual(parsePower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t12%; discharging; 1:02 remaining present: true"), { onBattery: true, percent: 12 });
  assert.deepEqual(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true"), { onBattery: false, percent: 100 });
  assert.deepEqual(parsePower("Now drawing from 'AC Power'\n"), { onBattery: false });
});
