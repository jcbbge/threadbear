"use node";
// Push notifications when a thread needs Mike: APNs over HTTP/2 with the
// team's token-based (ES256) auth key, the way poddle/convex/apns.ts does
// it. Env on the deployment: APNS_KEY_P8 (the .p8 contents), APNS_KEY_ID,
// APNS_TEAM_ID, APNS_TOPIC (the phone app's bundle id). Without them
// every send is a logged no-op. Each device row says whether it's a
// sandbox (Xcode) or production (TestFlight, App Store) install, and
// goes to the matching APNs host.
import { createCipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto';
import http2 from 'node:http2';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { failureText } from './pushHealth';
import { pushText } from './pushText';
import { API_VERSION } from './version';

// The push relay (relay/, docs/push-relay.md): Mike's Convex project that
// holds his Apple key, for backends that don't have one. A deployment with
// its own APNS_* env (Mike's) sends directly; PUSH_RELAY=off turns the relay
// off (and so notifications, for a backend with no key of its own).
const RELAY_URL = 'https://impartial-hound-393.ap-southeast-2.convex.site';

type Target = { apnsToken: string; environment: 'sandbox' | 'production'; notify: 'away' | 'always' | 'off'; pushKey?: string };

// AES-256-GCM with the phone's own key, as the app's notification extension
// opens it (CryptoKit's AES.GCM.SealedBox combined: nonce, ciphertext, tag).
export function seal(pushKey: string, text: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(pushKey, 'base64'), nonce);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

async function relayInstall(ctx: ActionCtx, url: string): Promise<{ installId: string; installKey: string } | { failure: string }> {
  const known = await ctx.runQuery(internal.devices.relayInstall, { url });
  if (known) return known;
  // The relay checks a registration really comes from the deployment it
  // names by posting the nonce back to that deployment's /relay/verify
  // (http.ts), so nobody can use up its allowance of new installs by
  // calling /register anonymously (relay/convex/http.ts).
  const deployment = process.env.CONVEX_SITE_URL;
  const nonce = randomBytes(24).toString('hex');
  if (deployment) await ctx.runMutation(internal.devices.startRelayCheck, { nonce });
  const res = await fetch(`${url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: `api-${API_VERSION}`, ...(deployment ? { deployment, nonce } : {}) }) }).catch((e: Error) => e);
  if (res instanceof Error || !res.ok) {
    const status = res instanceof Error ? 0 : res.status;
    const reason = res instanceof Error ? res.message : ((await res.json().catch(() => ({}))) as { error?: string }).error;
    console.warn(`[relay] couldn't register: ${failureText(status, reason)}`);
    return { failure: `${failureText(status)} couldn't register with the relay` };
  }
  const install = (await res.json()) as { installId: string; installKey: string };
  await ctx.runMutation(internal.devices.saveRelayInstall, { ...install, url });
  return install;
}

// Through the relay. A phone that sent its pushKey gets the title and text
// sealed with it, so the relay forwards only ciphertext; an older app
// without one gets the relay's plain "A thread needs you", never the text.
async function sendViaRelay(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, targets: Target[]): Promise<SendSummary> {
  if (process.env.PUSH_RELAY === 'off') return { sent: 0, failed: 0, skipped: 'relayOff' };
  const url = process.env.PUSH_RELAY_URL || RELAY_URL;
  const install = await relayInstall(ctx, url);
  if ('failure' in install) return { sent: 0, failed: targets.length, broken: targets.length, failure: install.failure };
  let sent = 0;
  let failed = 0;
  let broken = 0;
  let failure: string | undefined;
  for (const t of targets) {
    const res = await fetch(`${url}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${install.installId}.${install.installKey}`, 'X-Threadbear-Version': `api-${API_VERSION}` },
      body: JSON.stringify({ deviceToken: t.apnsToken, environment: t.environment, threadId: alert.threadId, ...(t.pushKey ? { encrypted: seal(t.pushKey, JSON.stringify({ title: alert.title, body: alert.body })) } : {}) }),
    }).catch((e: Error) => ({ ok: false, status: 0, json: async () => ({ reason: e.message }) }) as unknown as Response);
    const r = (await res.json().catch(() => ({}))) as { ok?: boolean; gone?: boolean; reason?: string; status?: number; error?: string };
    if (res.status === 401) {
      // The relay forgot this install: register again next time.
      await ctx.runMutation(internal.devices.clearRelayInstall, {});
    }
    if (r.ok) sent++;
    else {
      failed++;
      // Apple's status when the relay got that far (r.status), else the
      // relay's own HTTP status and error.
      const said = failureText(typeof r.status === 'number' ? r.status : res.status, r.reason ?? r.error);
      console.warn(`[relay] ${said} for …${t.apnsToken.slice(-6)}`);
      if (r.gone) await ctx.runMutation(internal.devices.drop, { apnsToken: t.apnsToken });
      else {
        broken++;
        failure ??= said;
      }
    }
  }
  return { sent, failed, broken, ...(failure ? { failure } : {}) };
}

type ApnsConfig = { key: string; keyId: string; teamId: string; topic: string };

function apnsConfig(): ApnsConfig | null {
  const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = process.env;
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_TOPIC) return null;
  return { key: toPem(APNS_KEY_P8), keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, topic: APNS_TOPIC };
}

function toPem(raw: string): string {
  const s = raw.replace(/\\n/g, '\n').trim();
  if (s.includes('BEGIN PRIVATE KEY')) return s;
  const body = s.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

let cachedJwt: { token: string; issuedAt: number; keyId: string } | null = null;

// Apple wants the provider token refreshed at most every 20 minutes and
// at least hourly.
function providerToken(cfg: ApnsConfig, nowMs = Date.now()): string {
  if (cachedJwt && cachedJwt.keyId === cfg.keyId && nowMs - cachedJwt.issuedAt < 50 * 60_000) return cachedJwt.token;
  const iat = Math.floor(nowMs / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))}.${b64url(JSON.stringify({ iss: cfg.teamId, iat }))}`;
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(cfg.key), dsaEncoding: 'ieee-p1363' });
  const token = `${input}.${b64url(signature)}`;
  cachedJwt = { token, issuedAt: nowMs, keyId: cfg.keyId };
  return token;
}

type SendResult = { token: string; status: number; reason?: string };

function sendOne(session: http2.ClientHttp2Session, cfg: ApnsConfig, jwt: string, token: string, payload: string): Promise<SendResult> {
  return new Promise((resolve) => {
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': cfg.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => (status = Number(headers[':status'] ?? 0)));
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      let reason: string | undefined;
      try {
        reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
      } catch {
        reason = body || undefined;
      }
      resolve({ token, status, reason });
    });
    req.on('error', (e) => resolve({ token, status: 0, reason: e.message }));
    req.setTimeout(10_000, () => {
      req.close();
      resolve({ token, status: 0, reason: 'timeout' });
    });
    req.end(payload);
  });
}

// For pushOutcome (pushHealth.ts), never returned by the actions: broken,
// the failures that weren't a phone Apple says is gone (that phone is
// dropped, and isn't the backend's problem), and the first one's
// "<status> <reason>".
type SendSummary = { sent: number; failed: number; skipped?: string; broken?: number; failure?: string };
const vSendResult = v.object({ sent: v.number(), failed: v.number(), skipped: v.optional(v.string()) });

// The payload the phone app expects (docs/convex-backend.md, section 6).
async function sendAlert(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, which: (notify: 'away' | 'always' | 'off') => boolean = (n) => n !== 'off'): Promise<SendSummary> {
  const viaRelay = !apnsConfig() || process.env.PUSH_VIA === 'relay';
  // A throw (a malformed APNS_KEY_P8 makes signing throw) counts as a
  // failure too, or a broken key would never be reported.
  let out: SendSummary;
  try {
    out = await deliver(ctx, alert, which);
  } catch (e) {
    console.error(`[push] send threw: ${(e as Error)?.name ?? 'Error'}`);
    out = { sent: 0, failed: 1, broken: 1, failure: '0 send threw' };
  }
  const { failure, broken, ...r } = out;
  await ctx.runMutation(internal.devices.pushOutcome, { sent: r.sent, failed: broken ?? 0, via: viaRelay ? 'relay' : 'apple', ...(failure ? { failure } : {}) });
  return r;
}

async function deliver(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, which: (notify: 'away' | 'always' | 'off') => boolean): Promise<SendSummary> {
  const all: Target[] = await ctx.runQuery(internal.devices.targets, {});
  const targets = all.filter((t) => which(t.notify));
  if (!targets.length) return { sent: 0, failed: 0, skipped: 'noDevices' };
  const cfg = apnsConfig();
  if (!cfg || process.env.PUSH_VIA === 'relay') return await sendViaRelay(ctx, alert, targets);
  const payload = JSON.stringify({ aps: { alert: { title: alert.title, body: alert.body }, sound: 'default', 'thread-id': alert.threadId }, threadId: alert.threadId });
  const jwt = providerToken(cfg);
  let sent = 0;
  let failed = 0;
  let broken = 0;
  let failure: string | undefined;
  for (const env of ['sandbox', 'production'] as const) {
    const tokens = targets.filter((t) => t.environment === env).map((t) => t.apnsToken);
    if (!tokens.length) continue;
    const host = env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const session = http2.connect(host);
    session.on('error', (e) => console.error(`[apns] session error: ${e.message}`));
    try {
      const results = await Promise.all(tokens.map((t) => sendOne(session, cfg, jwt, t, payload)));
      for (const r of results) {
        if (r.status === 200) sent++;
        else {
          failed++;
          console.warn(`[apns] ${r.status} ${r.reason ?? ''} for …${r.token.slice(-6)}`);
          if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered') {
            await ctx.runMutation(internal.devices.drop, { apnsToken: r.token });
          } else {
            broken++;
            failure ??= failureText(r.status, r.reason);
          }
        }
      }
    } finally {
      session.close();
    }
  }
  return { sent, failed, broken, ...(failure ? { failure } : {}) };
}

// Scheduled by sync:upsertThreads when a thread starts needing Mike, and by
// sync:setPresence (held: true) when he leaves the Mac with one still
// waiting. Each phone has its own setting: "always" gets every one, "away"
// (the default) only while he isn't at the Mac (the rest are held for when
// he leaves), "off" none.
export const notify = internalAction({
  args: { threadId: v.string(), held: v.optional(v.boolean()) },
  returns: vSendResult,
  handler: async (ctx, { threadId, held }): Promise<SendSummary> => {
    const t: { title: string; status: string; preview: string; pendingApproval?: any; needsYou: boolean; atMac: boolean; mac?: string } | null = await ctx.runQuery(internal.devices.threadForPush, { threadId });
    // It may have been seen on the Mac in the meantime.
    if (!t || !t.needsYou) return { sent: 0, failed: 0, skipped: 'noLongerNeedsYou' };
    const alert = { ...pushText(t), threadId };
    // A held push only goes to the phones that waited for it.
    if (held) return await sendAlert(ctx, alert, (n) => n === 'away');
    if (!t.atMac) return await sendAlert(ctx, alert);
    await ctx.runMutation(internal.devices.holdPush, { threadId });
    const r = await sendAlert(ctx, alert, (n) => n === 'always');
    return r.skipped === 'noDevices' ? { ...r, skipped: 'atMac' } : r;
  },
});

// A test to every registered phone:
//   npx convex run push:test '{"body":"hello from Convex"}' --prod
// (PUSH_VIA=relay in the env sends through the relay even with a key.)
export const test = internalAction({
  args: { title: v.optional(v.string()), body: v.optional(v.string()) },
  returns: vSendResult,
  handler: async (ctx, { title, body }): Promise<SendSummary> => await sendAlert(ctx, { title: title ?? 'Threadbear', body: body ?? 'Test notification', threadId: 'test' }),
});
