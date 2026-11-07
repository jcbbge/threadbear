// Which credential this Mac has for Threadbear's backend (src/convex-admin.ts):
// a cloud deploy key or a self-hosted admin key, never both, and the env a
// Convex CLI call gets from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConvexAdminError, convexEnv, envValue, prodArgs, readConvexAdmin, siteOf } from '../../src/convex-admin.ts';

function home(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-convex-admin-'));
  fs.mkdirSync(path.join(dir, 'secrets'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'secrets', name), text);
  return dir;
}

test('envValue reads quoted and bare values', () => {
  assert.equal(envValue('A=1\nCONVEX_DEPLOY_KEY="prod:x-1|abc"\n', 'CONVEX_DEPLOY_KEY'), 'prod:x-1|abc');
  assert.equal(envValue("CONVEX_SELF_HOSTED_URL='http://127.0.0.1:13210'  \n", 'CONVEX_SELF_HOSTED_URL'), 'http://127.0.0.1:13210');
  assert.equal(envValue('CONVEX_DEPLOY_KEY=prod:x|k', 'CONVEX_DEPLOY_KEY'), 'prod:x|k');
  assert.equal(envValue('XCONVEX_DEPLOY_KEY=nope', 'CONVEX_DEPLOY_KEY'), undefined);
});

test('a deploy key is a cloud backend, named by its prefix', () => {
  const a = readConvexAdmin(home({ 'convex-deploy.env': 'CONVEX_DEPLOY_KEY=prod:quick-fox-77|secret\n' }));
  assert.equal(a.kind, 'cloud');
  assert.ok(a.kind === 'cloud' && a.deployment === 'quick-fox-77' && a.key === 'prod:quick-fox-77|secret');
  assert.deepEqual(prodArgs(a), ['--prod']);
});

test('a self-hosted env file is a self-hosted backend', () => {
  const a = readConvexAdmin(home({ 'convex-self-hosted.env': 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210/\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|k\n' }));
  assert.equal(a.kind, 'selfHosted');
  assert.ok(a.kind === 'selfHosted' && a.url === 'http://127.0.0.1:13210' && a.adminKey === 'convex-self-hosted|k');
  assert.deepEqual(prodArgs(a), []);
});

test('neither file is none', () => {
  assert.equal(readConvexAdmin(home({})).kind, 'none');
});

test('both files is refused, so a deploy never goes to the wrong backend', () => {
  const h = home({ 'convex-deploy.env': 'CONVEX_DEPLOY_KEY=prod:a|b\n', 'convex-self-hosted.env': 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210\nCONVEX_SELF_HOSTED_ADMIN_KEY=k\n' });
  assert.throws(() => readConvexAdmin(h), (e: Error) => e instanceof ConvexAdminError && /Both/.test(e.message));
});

test('a self-hosted admin URL must be https or this Mac, with no login or path', () => {
  const bad = ['http://example.com:3210', 'https://user:pw@x.ts.net:3210', 'https://x.ts.net:3210/api', 'ftp://127.0.0.1', 'not a url'];
  for (const url of bad) {
    const h = home({ 'convex-self-hosted.env': `CONVEX_SELF_HOSTED_URL=${url}\nCONVEX_SELF_HOSTED_ADMIN_KEY=k\n` });
    assert.throws(() => readConvexAdmin(h), ConvexAdminError, url);
  }
  const ok = readConvexAdmin(home({ 'convex-self-hosted.env': 'CONVEX_SELF_HOSTED_URL=https://mac.tail1.ts.net:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=k\n' }));
  assert.ok(ok.kind === 'selfHosted' && ok.url === 'https://mac.tail1.ts.net:3210');
});

test('a file with its key line missing says so', () => {
  assert.throws(() => readConvexAdmin(home({ 'convex-deploy.env': '# nothing\n' })), /no CONVEX_DEPLOY_KEY/);
  assert.throws(() => readConvexAdmin(home({ 'convex-self-hosted.env': 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210\n' })), /no CONVEX_SELF_HOSTED_ADMIN_KEY/);
});

test('convexEnv carries only the one credential', () => {
  const base = { PATH: '/bin', CONVEX_DEPLOYMENT: 'dev:other', CONVEX_URL: 'https://other.convex.cloud', CONVEX_DEPLOY_KEY: 'stray', CONVEX_SELF_HOSTED_URL: 'http://stray', CONVEX_SELF_HOSTED_ADMIN_KEY: 'stray' };
  const cloud = convexEnv({ kind: 'cloud', file: 'f', key: 'prod:a|b' }, base);
  assert.equal(cloud.CONVEX_DEPLOY_KEY, 'prod:a|b');
  for (const k of ['CONVEX_DEPLOYMENT', 'CONVEX_URL', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) assert.equal(cloud[k], undefined, k);
  const sh = convexEnv({ kind: 'selfHosted', file: 'f', url: 'http://127.0.0.1:13210', adminKey: 'k' }, base);
  assert.equal(sh.CONVEX_SELF_HOSTED_URL, 'http://127.0.0.1:13210');
  assert.equal(sh.CONVEX_SELF_HOSTED_ADMIN_KEY, 'k');
  for (const k of ['CONVEX_DEPLOYMENT', 'CONVEX_URL', 'CONVEX_DEPLOY_KEY']) assert.equal(sh[k], undefined, k);
  assert.equal(sh.PATH, '/bin');
  const none = convexEnv({ kind: 'none', file: 'f', selfHostedFile: 'g' }, base);
  for (const k of ['CONVEX_DEPLOYMENT', 'CONVEX_URL', 'CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) assert.equal(none[k], undefined, k);
});

test('siteOf prefers sync.site, else the cloud twin', () => {
  assert.equal(siteOf('https://quick-fox-77.convex.cloud'), 'https://quick-fox-77.convex.site');
  assert.equal(siteOf('https://mac.tail1.ts.net:3210', 'https://mac.tail1.ts.net:3211/'), 'https://mac.tail1.ts.net:3211');
  assert.equal(siteOf('https://mac.tail1.ts.net:3210'), undefined);
  assert.equal(siteOf(undefined), undefined);
});
