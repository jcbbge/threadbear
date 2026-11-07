// Which URLs may carry a runner key or the gateway's token (src/secure-url.ts):
// https anywhere, plain http only to this machine. Daybreak, 7 Nov:
// "Credential-bearing sync and connector endpoints accept cleartext HTTP".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialUrlProblem, isLoopbackHost } from '../../src/secure-url.ts';

test('https anywhere and plain http to this Mac may carry a credential', () => {
  for (const url of [
    'https://opulent-moose-249.ap-southeast-2.convex.cloud',
    'https://bruce.tail9ef766.ts.net:8443/mcp',
    'HTTPS://X.Convex.Cloud',
    'http://127.0.0.1:3210',
    'http://127.4.5.6:8443/mcp',
    'http://localhost:3210',
    'http://LOCALHOST:3210',
    'HTTP://127.0.0.1:3210',
    'http://[::1]:3210',
    'http://[0:0:0:0:0:0:0:1]:3210',
    // URL's own spellings of 127.0.0.1.
    'http://127.1:3210',
    'http://2130706433:3210',
    ' http://127.0.0.1:3210 ',
  ]) {
    assert.equal(credentialUrlProblem(url), undefined, url);
  }
});

test('plain http anywhere else, look-alike hosts, userinfo and other schemes are refused', () => {
  for (const url of [
    'http://opulent-moose-249.ap-southeast-2.convex.cloud',
    'http://bruce.tail9ef766.ts.net:8443/mcp',
    'HTTP://evil.example',
    ' http://evil.example ',
    'http://evil.example\t',
    'http://127.0.0.1.evil.example',
    'http://127.0.0.1%2eevil.example',
    'http://localhost.evil.example',
    'http://localhost.',
    'http://0.0.0.0:3210',
    'http://192.168.1.10:3210',
    'http://[::ffff:127.0.0.1]:3210',
    'http://evil.example#@127.0.0.1',
    'http://evil.example\\@127.0.0.1',
    // Userinfo: the host is evil.example, and a password would end up in logs.
    'http://127.0.0.1@evil.example',
    'http://localhost:3210@evil.example',
    'https://user:pass@x.convex.cloud',
    'ws://127.0.0.1:3210',
    'ftp://x.example',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.ok(credentialUrlProblem(url), url);
  }
  // The reason never repeats a password from the URL.
  assert.doesNotMatch(credentialUrlProblem('https://user:hunter2@x.convex.cloud')!, /hunter2|user/);
  assert.match(credentialUrlProblem('http://x.example')!, /https/);
});

test('loopback hosts are exactly localhost, 127.0.0.0/8 and [::1]', () => {
  assert.ok(isLoopbackHost('127.0.0.1'));
  assert.ok(isLoopbackHost('127.255.255.255'));
  assert.ok(isLoopbackHost('[::1]'));
  assert.ok(isLoopbackHost('localhost'));
  assert.ok(!isLoopbackHost('127.0.0.256'));
  assert.ok(!isLoopbackHost('127.0.0.1.evil.example'));
  assert.ok(!isLoopbackHost('128.0.0.1'));
  assert.ok(!isLoopbackHost('::1'));
});
