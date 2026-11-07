// app/Tools/dev-app.sh's reap: a start still under way (no app pid yet),
// or a rebuild, is left alone while the dev-app.sh doing it is running,
// however long its build takes, and a start is cleaned up 10 minutes on
// once that process has gone. A busy Mac's 20-minute build was reaped at
// 10 by another thread's start (6 Nov). Runs the real script's status
// (which reaps) against a temp TMPDIR, with hand-made instance folders and
// no app or build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const DEV_APP = path.join(import.meta.dirname, '..', '..', '..', 'app', 'Tools', 'dev-app.sh');

function lstart(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
}

test('reap keeps a start whose dev-app.sh is still running, and clears one whose has gone', async () => {
  const tmp = tmpDir('dev-app-reap-');
  const root = path.join(tmp, 'threadbear-dev-app');
  const old = Math.floor(Date.now() / 1000) - 3600;
  // Stands in for a dev-app.sh still building.
  const building = spawn('sleep', ['60'], { stdio: 'ignore' });
  // One that has exited.
  const gone = spawn('true', [], { stdio: 'ignore' });
  await new Promise((resolve) => gone.on('exit', resolve));
  try {
    const instances: Record<string, string[]> = {
      building: [`starter=${building.pid}`, `starter_since=${lstart(building.pid!)}`],
      gone: [`starter=${gone.pid}`, 'starter_since=Thu Jan  1 00:00:00 1970'],
      // The pid alive but not the process that recorded it (reused).
      reused: [`starter=${building.pid}`, 'starter_since=Thu Jan  1 00:00:00 1970'],
      // From before dev-app.sh recorded its starter.
      legacy: [],
    };
    for (const [id, extra] of Object.entries(instances)) {
      fs.mkdirSync(path.join(root, id), { recursive: true });
      fs.writeFileSync(path.join(root, id, 'instance'),
        ['thread=someone-else', `checkout=${tmp}`, `created=${old}`, ...extra].join('\n') + '\n');
    }
    // The caller's own, mid-rebuild: the old app's pid is gone, which
    // would have it cleaned up straight away, but the rebuild is running.
    fs.mkdirSync(path.join(root, 'rebuilding'));
    fs.writeFileSync(path.join(root, 'rebuilding', 'instance'),
      [`thread=test-thread`, `checkout=${fs.realpathSync(path.join(import.meta.dirname, '..', '..', '..'))}`, `created=${old}`,
        `pid=${gone.pid}`, `starter=${building.pid}`, `starter_since=${lstart(building.pid!)}`].join('\n') + '\n');
    // Under the 10 minutes, with its dev-app.sh gone: still left.
    fs.mkdirSync(path.join(root, 'fresh'));
    fs.writeFileSync(path.join(root, 'fresh', 'instance'),
      `thread=someone-else\ncheckout=${tmp}\ncreated=${Math.floor(Date.now() / 1000)}\nstarter=${gone.pid}\n`);

    execFileSync('bash', [DEV_APP, 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: tmp, THREADBEAR_THREAD_ID: 'test-thread' },
    });

    const left = fs.readdirSync(root).filter((id) => fs.existsSync(path.join(root, id, 'instance'))).sort();
    assert.deepEqual(left, ['building', 'fresh', 'rebuilding']);
  } finally {
    building.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
