// Which credential this Mac holds for Threadbear's own Convex backend, and
// the env a Convex CLI call needs to use that and nothing else.
//
// - Convex cloud (the default, and the one we recommend): a deploy key in
//   <home>/secrets/convex-deploy.env, made by setup.
// - A self-hosted backend (setup --self-hosted, docs/self-hosting.md): the
//   backend's admin URL on this Mac and its admin key, in
//   <home>/secrets/convex-self-hosted.env.
//
// Shared by setup (scripts/setup.mjs), the backend deploy
// (runner/scripts/deploy-backend.mjs, which runs from a runner release, so
// this file lives in runner/) and `tb runner` (runner-keys.ts). Node
// built-ins only, as setup runs it before any packages are installed.
import fs from 'node:fs';
import path from 'node:path';

export const DEPLOY_ENV_FILE = 'convex-deploy.env';
export const SELF_HOSTED_ENV_FILE = 'convex-self-hosted.env';

export type ConvexAdmin =
  | { kind: 'cloud'; file: string; key: string; deployment?: string }
  | { kind: 'selfHosted'; file: string; url: string; adminKey: string }
  | { kind: 'none'; file: string; selfHostedFile: string };

export class ConvexAdminError extends Error {}

// `NAME=value` from an env file, with or without quotes around the value.
export function envValue(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`^${name}=["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
  return m?.[1];
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// The admin URL is where this Mac's CLI reaches the backend: the container's
// loopback port, or the tailnet name. Never anything with a login or a path
// in it, since the admin key goes with every request to it.
function adminUrl(raw: string | undefined, file: string): string {
  let u: URL;
  try {
    u = new URL(raw ?? '');
  } catch {
    throw new ConvexAdminError(`${file} has no usable CONVEX_SELF_HOSTED_URL= line.`);
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new ConvexAdminError(`${file}'s CONVEX_SELF_HOSTED_URL must be https, or http on this Mac (127.0.0.1), with no path.`);
  }
  return u.origin;
}

export function readConvexAdmin(home: string): ConvexAdmin {
  const file = path.join(home, 'secrets', DEPLOY_ENV_FILE);
  const selfHostedFile = path.join(home, 'secrets', SELF_HOSTED_ENV_FILE);
  const cloud = readText(file);
  const selfHosted = readText(selfHostedFile);
  // Both would mean a deploy could go to one backend while the runner
  // mirrors to the other, so neither is used until one goes.
  if (cloud !== undefined && selfHosted !== undefined) {
    throw new ConvexAdminError(`Both ${file} (Convex cloud) and ${selfHostedFile} (self-hosted) are here, so it isn't clear which backend is Threadbear's. Remove the one you don't use.`);
  }
  if (selfHosted !== undefined) {
    const adminKey = envValue(selfHosted, 'CONVEX_SELF_HOSTED_ADMIN_KEY');
    if (!adminKey) throw new ConvexAdminError(`${selfHostedFile} has no CONVEX_SELF_HOSTED_ADMIN_KEY= line.`);
    return { kind: 'selfHosted', file: selfHostedFile, url: adminUrl(envValue(selfHosted, 'CONVEX_SELF_HOSTED_URL'), selfHostedFile), adminKey };
  }
  if (cloud !== undefined) {
    const key = envValue(cloud, 'CONVEX_DEPLOY_KEY');
    if (!key) throw new ConvexAdminError(`${file} has no CONVEX_DEPLOY_KEY= line.`);
    // A "prod:<name>|..." key names its deployment.
    const deployment = key.match(/^[a-z]+:([a-z0-9-]+)\|/)?.[1];
    return { kind: 'cloud', file, key, ...(deployment ? { deployment } : {}) };
  }
  return { kind: 'none', file, selfHostedFile };
}

// Everything that can point the Convex CLI at a deployment. Only the admin
// credential picks it: a checkout's .env.local or a thread's environment
// could name another one.
const CONVEX_TARGET_VARS = ['CONVEX_DEPLOYMENT', 'CONVEX_URL', 'CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY'];

export function convexEnv(admin: ConvexAdmin, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of CONVEX_TARGET_VARS) delete env[k];
  if (admin.kind === 'cloud') env.CONVEX_DEPLOY_KEY = admin.key;
  else if (admin.kind === 'selfHosted') {
    env.CONVEX_SELF_HOSTED_URL = admin.url;
    env.CONVEX_SELF_HOSTED_ADMIN_KEY = admin.adminKey;
  }
  return env;
}

// The CLI's --prod picks a cloud project's production deployment, and it
// refuses the flag on a self-hosted backend (there's only one deployment).
export function prodArgs(admin: ConvexAdmin): string[] {
  return admin.kind === 'cloud' ? ['--prod'] : [];
}

// Where the website is: runner.json's sync.site when set (a self-hosted
// backend serves it on a port of its own), else a cloud deployment's
// .convex.site twin of its .convex.cloud URL. Anything else has none.
export function siteOf(url: string | undefined, site?: string): string | undefined {
  if (site?.trim()) return site.trim().replace(/\/+$/, '');
  if (!url || !url.includes('.convex.cloud')) return undefined;
  return url.replace(/\/+$/, '').replace('.convex.cloud', '.convex.site');
}
