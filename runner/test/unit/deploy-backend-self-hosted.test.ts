// runner/scripts/deploy-backend.mjs with a self-hosted backend
// (docs/self-hosting.md): it deploys with the admin URL and key rather than
// a deploy key, and won't guess when both kinds of credential are here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const repo = path.resolve(import.meta.dirname, '../../..');

function deploy(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(repo, 'runner/scripts/deploy-backend.mjs'), '--home', home, '--repo', repo, ...args], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
}

function selfHostedHome(): string {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'convex-key'), 'main-key\n');
  fs.writeFileSync(path.join(home, 'secrets', 'convex-self-hosted.env'), 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|x\n');
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { url: 'https://mac.tail1.ts.net:3210', site: 'https://mac.tail1.ts.net:3211' } }));
  return home;
}

test('a self-hosted backend is deployed with its admin URL, never a deploy key', () => {
  const home = selfHostedHome();
  const r = deploy(home, '--dry-run', '--force');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-hosted backend at http:\/\/127\.0\.0\.1:13210/);
  assert.doesNotMatch(r.stdout + r.stderr, /convex-self-hosted\|x/, 'the admin key is never printed');
  assert.equal(fs.existsSync(path.join(home, 'backend.json')), false, 'nothing deployed');
});

test('a deploy key and a self-hosted key together stop the deploy', () => {
  const home = selfHostedHome();
  fs.writeFileSync(path.join(home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:opulent-moose-249|x\n');
  const r = deploy(home, '--dry-run', '--force');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Both .* are here/);
});

// As deploy-backend.mjs treeOf: the object hashes of the paths at HEAD, joined.
function treeOf(paths: string[]): string {
  const out = spawnSync('git', ['-C', repo, 'ls-tree', 'HEAD', '--', ...paths], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]).join('+');
}

test('the website is built again when the backend address changes, even with the same code', () => {
  const home = selfHostedHome();
  const functions = treeOf(['convex', 'convex.json', 'package.json', 'package-lock.json']);
  const site = treeOf(['web', 'package.json', 'package-lock.json']);
  const state = (url?: string) => fs.writeFileSync(path.join(home, 'backend.json'), JSON.stringify({ functions: { tree: functions }, site: { tree: site, ...(url ? { url } : {}) } }));
  // The same address: nothing to do.
  state('https://mac.tail1.ts.net:3210');
  assert.match(deploy(home, '--dry-run').stdout, /up to date/);
  // The Mac was renamed: the website (only) goes again.
  state('https://old-name.tail1.ts.net:3210');
  const r = deploy(home, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Would deploy the website at/);
  // A deploy from before the address was recorded isn't redone for that alone.
  state();
  assert.match(deploy(home, '--dry-run').stdout, /up to date/);
});
