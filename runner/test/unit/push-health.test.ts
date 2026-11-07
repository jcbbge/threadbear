// Whether pushes get through (convex/pushHealth.ts), what tb status says
// about it (src/push-failing.ts), and the relay's tally of why sends fail
// (relay/convex/relay.ts reasonKey).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureText, nextHealth, pushFailing, PUSH_FAILING_FRESH_MS } from '../../../convex/pushHealth.ts';
import { asPushFailing, pushFailingText } from '../../src/push-failing.ts';

test('a failing run starts, counts and clears on the first push that gets through', () => {
  let h = nextHealth({}, { sent: 0, failed: 2, failure: '403 InvalidProviderToken', via: 'relay' }, 1000);
  h = nextHealth(h, { sent: 0, failed: 1, failure: '0 timeout', via: 'relay' }, 2000);
  assert.deepEqual(pushFailing(h, 3000), { failure: '0 timeout', since: 1000, failed: 3, via: 'relay' });
  assert.equal(nextHealth(h, { sent: 0, failed: 0, via: 'relay' }, 2500), h, 'nothing sent changes nothing');
  h = nextHealth(h, { sent: 1, failed: 1, via: 'apple' }, 4000);
  assert.equal(pushFailing(h, 4000), null);
  assert.equal(h.lastOkAt, 4000);
});

test('an old failure stops being news', () => {
  const h = nextHealth({}, { sent: 0, failed: 1, failure: '500', via: 'apple' }, 0);
  assert.ok(pushFailing(h, PUSH_FAILING_FRESH_MS));
  assert.equal(pushFailing(h, PUSH_FAILING_FRESH_MS + 1), null);
  assert.equal(pushFailing(null, 0), null);
});

test('failure text keeps the status and a known reason, never free text', () => {
  assert.equal(failureText(403, 'InvalidProviderToken'), '403 InvalidProviderToken');
  assert.equal(failureText(0), '0');
  assert.equal(failureText(0, 'timeout'), '0 timeout');
  assert.equal(failureText(0, 'connect ECONNREFUSED 10.0.0.1:443'), '0 ECONNREFUSED');
  // A relay (anyone's, through PUSH_RELAY_URL) that echoes a device token or thread text.
  const token = 'ab'.repeat(32);
  assert.equal(failureText(400, `Rejected device token ${token}`), '400 other');
  assert.equal(failureText(400, 'Mike your build finished'), '400 other');
  assert.equal(failureText(400, 'ConfidentialAcquisition'), '400 other', 'a word that only looks like one of Apple\'s');
  assert.equal(failureText(0, 'EPRIVATETEXT'), '0 other');
  assert.equal(failureText(0, 'getaddrinfo EAI_AGAIN x.convex.site'), '0 EAI_AGAIN');
});

test('tb status says whose key Apple turned down', () => {
  const since = Date.parse('2026-11-05T02:00:00Z');
  assert.match(pushFailingText({ failure: '403 InvalidProviderToken', since, failed: 52, via: 'relay' }), /52 failed since 2026-11-05 02:00 UTC.*push relay's key.*github/);
  assert.match(pushFailingText({ failure: '403 InvalidProviderToken', since, failed: 1, via: 'apple' }), /APNS_KEY_P8/);
  assert.doesNotMatch(pushFailingText({ failure: '0 timeout', since, failed: 1, via: 'relay' }), /turned down/);
  assert.equal(asPushFailing({ failure: 1 }), undefined);
  assert.equal(asPushFailing({ failure: 'x', since: 1, failed: 1, via: 'odd' })?.via, 'relay');
});

test("the relay tallies a failure's status and reason, never anything longer", async () => {
  const { reasonKey } = await import('../../../relay/convex/reasons.ts');
  assert.equal(reasonKey(403, 'InvalidProviderToken'), '403 InvalidProviderToken');
  assert.equal(reasonKey(0, 'relay not configured'), '0 relay not configured');
  assert.equal(reasonKey(500), '500');
  assert.equal(reasonKey(0, 'connect ECONNREFUSED 10.0.0.1:443'), '0 ECONNREFUSED');
  assert.equal(reasonKey(400, `token ${'ab'.repeat(32)}`), '400 other');
  assert.equal(reasonKey(400, 'ConfidentialAcquisition'), '400 other');
});

test("the relay and the backend keep the same lists of Apple's reasons and socket codes", async () => {
  const relay = await import('../../../relay/convex/reasons.ts');
  const backend = await import('../../../convex/pushHealth.ts');
  assert.deepEqual([...relay.APPLE].sort(), [...backend.APPLE_REASONS].sort());
  assert.deepEqual([...relay.SOCKET].sort(), [...backend.SOCKET_CODES].sort());
});

test('pushOff: only with the relay off and no Apple key of its own', async () => {
  const { pushOff } = await import('../../../convex/pushHealth.ts');
  assert.equal(pushOff({}), false);
  assert.equal(pushOff({ PUSH_RELAY: 'off' }), true);
  assert.equal(pushOff({ PUSH_RELAY: 'off', APNS_KEY_P8: 'k', APNS_KEY_ID: 'i', APNS_TEAM_ID: 't', APNS_TOPIC: 'b' }), false);
  // Half an Apple key is no key: push.ts sends nothing with it.
  assert.equal(pushOff({ PUSH_RELAY: 'off', APNS_KEY_P8: 'k' }), true);
  assert.equal(pushOff({ PUSH_RELAY: 'on' }), false);
});
