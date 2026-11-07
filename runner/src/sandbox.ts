// Threads that run their CLI in a container (an experiment from 6 Nov 2026,
// docs/protocol.md "Sandboxed threads"). runner.json's `sandbox` names
// folders, and a thread under one of them has its Claude Code run inside
// `docker run` from `image`, with only its own folder, its login's config
// and the CLI itself mounted in, each at the same path as on the runner's
// machine. Everything else (the runner, its data and secrets, other repos)
// isn't there, so an agent with full access can only touch its thread's
// folder. The runner stays where it is: transcripts, pools, schedules and
// Convex sync don't change, and the threadbear tools and hooks reach the CLI
// over the same stdin and stdout as always.
//
// A sandbox lasts as long as the CLI does. When a thread goes idle the
// runner stops its CLI, the container goes with it (--rm), and the next
// message starts a fresh one that resumes the session from the login's
// config folder. Nothing outside the mounts survives that: an installed
// package, a running server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

export type SandboxConfig = {
  folders: string[]; // absolute, ~ expanded
  image: string;
  docker: string; // the docker binary
};

// runner.json's `sandbox`, or undefined when it's missing or unusable.
export function readSandbox(raw: unknown, expandHome: (p: string) => string): SandboxConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const folders = Array.isArray(r.folders) ? r.folders.filter((f): f is string => typeof f === 'string' && !!f.trim()).map((f) => path.resolve(expandHome(f.trim()))) : [];
  const image = typeof r.image === 'string' && r.image.trim() ? r.image.trim() : undefined;
  if (!folders.length || !image) return undefined;
  return { folders, image, docker: typeof r.docker === 'string' && r.docker.trim() ? r.docker.trim() : 'docker' };
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const inside = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// Said when a thread shut in a sandbox (ThreadRecord.confined) would have
// to run outside one: its folder isn't in one now, or isn't really there.
export const CONFINED_NO_SANDBOX = (cwd: string) =>
  `This thread runs in a sandbox, but ${cwd} isn't in a sandbox folder now, so it wasn't started. Move it back into one, or start a new thread there.`;

// The sandbox a thread in `cwd` runs in, if its folder is under one of the
// configured ones.
export function sandboxFor(sb: SandboxConfig | undefined, cwd: string): SandboxConfig | undefined {
  if (!sb) return undefined;
  const at = real(cwd);
  return sb.folders.some((f) => inside(at, real(f))) ? sb : undefined;
}

// Variables the container gets its own of, rather than the runner's.
const OWN_ENV = new Set(['PATH', 'HOME', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL']);

export type DockerRun = { command: string; args: string[]; name: string };

// The `docker run` for one CLI start. Pure, so it can be tested without
// docker: `exists` says whether a path is there (for args the SDK hands the
// CLI by absolute path, like a settings file), `home` and the ids are the
// runner's user, whose files the container's user owns.
export function dockerRun(
  spawn: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> },
  sb: SandboxConfig,
  ctx: { threadId: string; home: string; uid: number; gid: number; exists: (p: string) => boolean; realpath: (p: string) => string },
): DockerRun {
  const name = `tb-${ctx.threadId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  const mounts = new Map<string, 'rw' | 'ro'>();
  const mount = (p: string, mode: 'rw' | 'ro') => {
    if (mounts.get(p) === 'rw') return;
    mounts.set(p, mode);
  };
  const cwd = ctx.realpath(spawn.cwd ?? ctx.home);
  // Checked again where the folder is mounted from: a link put in its
  // place since the thread was matched to the sandbox would mount
  // wherever it points (Daybreak, 7 Nov 2026).
  if (!sb.folders.some((f) => inside(cwd, ctx.realpath(f)))) throw new Error(CONFINED_NO_SANDBOX(spawn.cwd ?? ctx.home));
  mount(cwd, 'rw');
  // The login's config: sessions, credentials, checkpoints. ~/.claude.json
  // sits beside the default one.
  const configDir = spawn.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, '.claude');
  if (ctx.exists(configDir)) mount(ctx.realpath(configDir), 'rw');
  if (!spawn.env.CLAUDE_CONFIG_DIR && ctx.exists(path.join(ctx.home, '.claude.json'))) mount(path.join(ctx.home, '.claude.json'), 'rw');
  // The CLI: the native installer's ~/.local/bin/claude is a link into its
  // versions folder, so the real file goes in and is what runs.
  const command = ctx.realpath(spawn.command);
  mount(command, 'ro');
  // Anything else the CLI is handed by absolute path that's on this machine.
  for (const a of spawn.args) if (path.isAbsolute(a) && ctx.exists(a)) mount(ctx.realpath(a), 'ro');
  const env: string[] = [];
  for (const k of Object.keys(spawn.env)) if (spawn.env[k] !== undefined && !OWN_ENV.has(k)) env.push('-e', k);
  const args = [
    'run', '-i', '--rm', '--init', '--name', name,
    '--user', `${ctx.uid}:${ctx.gid}`,
    '-e', `HOME=${ctx.home}`,
    ...env,
    ...[...mounts].flatMap(([p, mode]) => ['-v', `${p}:${p}${mode === 'ro' ? ':ro' : ''}`]),
    '-w', cwd,
    sb.image, command, ...spawn.args,
  ];
  return { command: sb.docker, args, name };
}

// A spawner (proc.ts's groupSpawner) whose CLI runs in the sandbox. The env
// is passed to `docker` itself, which hands each `-e NAME` on. Stopping the
// CLI stops the docker client; the container is killed too, as a client
// that's killed outright leaves its container running.
export function sandboxSpawner(base: (o: SpawnOptions) => SpawnedProcess, sb: SandboxConfig, threadId: string): (o: SpawnOptions) => SpawnedProcess {
  const me = os.userInfo();
  return (o) => {
    const run = dockerRun({ command: o.command, args: o.args, cwd: o.cwd, env: o.env as Record<string, string | undefined> }, sb, {
      threadId,
      home: os.homedir(),
      uid: me.uid,
      gid: me.gid,
      exists: (p) => fs.existsSync(p),
      realpath: real,
    });
    o.signal.addEventListener('abort', () => execFile(sb.docker, ['kill', run.name], () => {}), { once: true });
    return base({ ...o, command: run.command, args: run.args });
  };
}
