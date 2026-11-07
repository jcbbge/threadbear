// The relay's whole API (docs/push-relay.md):
//
//   POST /register  { version?, deployment, nonce }  ->  { installId, installKey }
//     Once per Threadbear backend, which keeps the pair in its database.
//     The relay first posts { nonce } to <deployment>/relay/verify (its
//     CONVEX_SITE_URL) and registers only if that answers { ok: true }
//     (verify.ts says why); 403 without them or if it doesn't.
//
//   POST /send  Authorization: Bearer <installId>.<installKey>
//     { deviceToken, environment: "sandbox" | "production", threadId,
//       encrypted?: base64 AES-GCM sealed box, or title?/body? }
//     ->  { ok, status, reason?, gone? }  (gone: drop this device token)
//
// Nothing here is stored but the install row and daily counts.
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { convexSite, deploymentVouches } from './verify';
import { reasonKey } from './reasons';
import { storedVersion } from './versions';

const http = httpRouter();

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 16_000) return null;
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

http.route({
  path: '/register',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const b = await body(req);
    if (!b) return json({ error: 'bad request' }, 400);
    // Anything but a plain version word is stored as "unknown" (versions.ts).
    const version = b.version === undefined ? undefined : storedVersion(b.version);
    // Only a deployment that proves it's the caller gets an install
    // (verify.ts says how). There used to be an unchecked way too, for
    // backends from before 5 Nov 2026, with a shared daily allowance; but
    // anyone could use that up and lock out everyone relying on it, and
    // when it went the relay's only install (Mike's) already worked, so
    // nobody lost anything. Installs that work keep working: /send never
    // asks how an install was made.
    const site = convexSite(str(b.deployment, 200));
    const nonce = str(b.nonce, 100);
    if (!site || !nonce) return json({ error: 'update Threadbear: this relay only registers Convex cloud deployments that confirm the registration (docs/push-relay.md)' }, 403);
    if (!(await deploymentVouches(site, nonce))) return json({ error: "the deployment didn't confirm this registration" }, 403);
    try {
      return json(await ctx.runMutation(internal.relay.registerVerified, { deployment: site, ...(version ? { version } : {}) }));
    } catch {
      return json({ error: 'too many new installs today' }, 429);
    }
  }),
});

http.route({
  path: '/send',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get('authorization')?.match(/^Bearer (i_[0-9a-f]+)\.(k_[0-9a-f]+)$/);
    if (!auth) return json({ error: 'unauthorized' }, 401);
    const b = await body(req);
    const deviceToken = str(b?.deviceToken, 200);
    const environment = b?.environment === 'production' ? 'production' : b?.environment === 'sandbox' ? 'sandbox' : undefined;
    const threadId = str(b?.threadId, 100);
    if (!b || !deviceToken || !/^[0-9a-f]+$/i.test(deviceToken) || !environment || !threadId) return json({ error: 'bad request' }, 400);
    const header = req.headers.get('x-threadbear-version');
    const version = header === null ? undefined : storedVersion(header);
    const admitted = await ctx.runMutation(internal.relay.admit, { installId: auth[1]!, installKey: auth[2]!, ...(version ? { version } : {}) });
    if (admitted === 'auth') return json({ error: 'unauthorized' }, 401);
    if (admitted === 'limited') return json({ error: 'rate limited' }, 429);
    const encrypted = str(b.encrypted, 4000);
    // A throw (a malformed APNS_KEY_P8 makes signing throw) is counted
    // like any other failure, so relay:stats sees it.
    const r = await ctx.runAction(internal.apns.send, {
      deviceToken,
      environment,
      threadId,
      ...(encrypted ? { encrypted } : { ...(str(b.title, 200) ? { title: str(b.title, 200) } : {}), ...(str(b.body, 1000) ? { body: str(b.body, 1000) } : {}) }),
    }).catch(() => ({ status: 0, reason: 'send threw' }) as { status: number; reason?: string });
    const ok = r.status === 200;
    // The status and Apple's reason only (no token, no install), so the
    // relay's own logs say why sends fail; relay:stats tallies the same.
    if (!ok) console.warn(`[send] failed: ${reasonKey(r.status, r.reason)}`);
    await ctx.runMutation(internal.relay.counted, { ok, status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    const gone = r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered';
    return json({ ok, status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(gone ? { gone: true } : {}) });
  }),
});

http.route({ path: '/health', method: 'GET', handler: httpAction(async () => json({ ok: true })) });

export default http;
