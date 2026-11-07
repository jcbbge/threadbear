import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonLook, type MessageButton } from './reply-buttons.ts';

const start: MessageButton = { id: 'abcd1234', title: 'Fill in the form', kind: 'start', target: 'pebble' };
const send: MessageButton = { id: 'efgh5678', title: 'Ask it', kind: 'send', target: 'Meetup' };

test('a button says where it goes until it is pressed', () => {
  assert.deepEqual(buttonLook(start, undefined, false), { kind: 'ready', tip: 'Starts a thread in pebble' });
  assert.deepEqual(buttonLook(send, undefined, false), { kind: 'ready', tip: 'Sends a message to "Meetup"' });
});

test('a press shows as pressing until its command is done, then pressed with the thread to open', () => {
  assert.equal(buttonLook(start, undefined, true).kind, 'pressing');
  assert.equal(buttonLook(start, { state: 'pending' }, true).kind, 'pressing');
  assert.equal(buttonLook(start, { state: 'taken' }, true).kind, 'pressing');
  assert.deepEqual(buttonLook(start, { state: 'done', threadId: 't2' }, false), { kind: 'pressed', threadId: 't2', tip: 'Pressed.' });
});

test('the row saying pressed wins, wherever it was pressed', () => {
  assert.equal(buttonLook({ ...start, pressedThreadId: 't3' }, undefined, false).kind, 'pressed');
  assert.equal(buttonLook({ ...start, pressedThreadId: 't3' }, { state: 'failed', note: 'x' }, false).kind, 'pressed');
});

test('a failed press shows its error and can be pressed again', () => {
  const look = buttonLook(start, { state: 'failed', note: 'Folder not found: /x' }, false);
  assert.equal(look.kind, 'failed');
  assert.equal(look.kind === 'failed' && look.error, 'Folder not found: /x');
  assert.equal(buttonLook({ ...start, failed: 'gone' }, undefined, false).kind, 'failed');
});
