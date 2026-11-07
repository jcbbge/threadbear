// runner/scripts/deploy-backend.mjs with another deploy already running: it
// waits for that one rather than failing, then deploys only what's still
// left. On 6 Nov an old runner handing over was deploying main's backend
// while the new runner started its own for the same commit, and the second
// one's "Another backend deploy is running" stopped the update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const script = path.join(repo, 'runner/scripts/deploy-backend.mjs');

// The same hashes the script compares (its treeOf).
function treeOf(paths: string[]): string {
  const out = spawnSync('git', ['-C', repo, 'ls-tree', 'HEAD', '--', ...paths], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]).join('+');
}

test('a second backend deploy waits for the first, then has nothing left to do', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  // A made-up deployment: if the wait were wrong, nothing real is reached.
  fs.writeFileSync(path.join(home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:no-such-deploy-000|x\n');
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { url: 'https://no-such-deploy-000.example.invalid' } }));
  const done = {
    functions: { tree: treeOf(['convex', 'convex.json', 'package.json', 'package-lock.json']) },
    site: { tree: treeOf(['web', 'package.json', 'package-lock.json']) },
  };
  // The first deploy: holds the kernel lock the script takes, says so with
  // a ready file, and once told to (the second has said it's waiting)
  // records its deploy and lets go.
  const lockFile = path.join(home, 'backend.flock');
  const ready = path.join(home, 'ready');
  const release = path.join(home, 'release');
  const holderJs = `const fs = require('fs'); setTimeout(() => process.exit(1), 60000).unref(); fs.writeFileSync(${JSON.stringify(ready)}, ''); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { fs.writeFileSync(${JSON.stringify(path.join(home, 'backend.json'))}, ${JSON.stringify(JSON.stringify(done))}); clearInterval(t); } }, 20);`;
  const holder = process.platform === 'darwin' ? ['/usr/bin/lockf', ['-k', lockFile, process.execPath, '-e', holderJs]] as const : ['flock', [lockFile, process.execPath, '-e', holderJs]] as const;
  const first = spawn(holder[0], [...holder[1]], { stdio: 'ignore' });
  const firstDone = new Promise((resolve) => first.on('close', resolve));
  // Its command only runs once the lock is held.
  while (!fs.existsSync(ready)) await new Promise((r) => setTimeout(r, 20));
  const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, [script, '--home', home, '--repo', repo], { env: { ...process.env, PATH: '/usr/bin:/bin' } });
    let out = '';
    const seen = (d: Buffer) => {
      out += d;
      if (/Waiting for another backend deploy/.test(out)) fs.writeFileSync(release, '');
    };
    c.stdout.on('data', seen);
    c.stderr.on('data', seen);
    c.on('close', (status) => resolve({ status, out }));
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Waiting for another backend deploy/);
  assert.match(r.out, /up to date/);
  await firstDone;
});
