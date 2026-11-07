// Whether this backend's pushes are getting through, so whoever runs it
// hears when they stop. On 5 and 6 Nov 2026 every push through the relay
// failed for two days (Apple had turned its key down) and nothing said so:
// each failure was a line in the deployment's logs, which nobody reads.
// Now push.ts records each send's outcome here, and the owner runner's
// heartbeat (sync.ts) carries what's failing to `tb status` and the app.
// Plain TypeScript with no Convex imports, so the runner's unit tests can
// check it.

export type PushVia = 'apple' | 'relay';

// Whether this backend can't send pushes at all: the relay is off
// (PUSH_RELAY=off, which setup sets on a self-hosted backend, as the relay
// only calls back to Convex's own hosts: relay/convex/verify.ts) and it has
// no Apple key of its own. The phone's Settings and the Mac's Phone & browser
// say so, rather than notifications just never coming (docs/self-hosting.md).
export function pushOff(env: Record<string, string | undefined>): boolean {
  const ownKey = Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
  return env.PUSH_RELAY === 'off' && !ownKey;
}

export type PushHealth = {
  lastOkAt?: number;
  // The first failure since the last push that got through, the latest,
  // how many, and the latest's "<status> <reason>".
  failingSince?: number;
  lastFailAt?: number;
  failed?: number;
  lastFailure?: string;
  via?: PushVia;
};

export type PushOutcome = { sent: number; failed: number; failure?: string; via: PushVia };

export type PushFailing = { failure: string; since: number; failed: number; via: PushVia };

// Failures older than this aren't news any more (no push has been tried
// since), so the warning goes rather than nagging for ever.
export const PUSH_FAILING_FRESH_MS = 3 * 86_400_000;

// A failure's text is a status and a reason from a fixed set, never free
// text: a relay (PUSH_RELAY_URL can name anyone's) or a socket error could
// put a device token, a key or thread text in its message, and this goes
// in logs, the pushHealth row and the runner's notice. Only Apple's own
// reasons, a socket error's code (ECONNREFUSED) and the relay's own few
// are kept; anything else is "other".
// Apple's documented reasons (developer.apple.com, "Handling notification
// responses from APNs"); keep in step with relay/convex/reasons.ts.
export const APPLE_REASONS = new Set([
  'BadCollapseId', 'BadDeviceToken', 'BadExpirationDate', 'BadMessageId', 'BadPriority', 'BadTopic',
  'DeviceTokenNotForTopic', 'DuplicateHeaders', 'IdleTimeout', 'InvalidPushType', 'MissingDeviceToken', 'MissingTopic',
  'PayloadEmpty', 'TopicDisallowed', 'BadCertificate', 'BadCertificateEnvironment', 'ExpiredProviderToken', 'Forbidden',
  'InvalidProviderToken', 'MissingProviderToken', 'UnrelatedKeyIdInToken', 'BadEnvironmentKeyInToken', 'BadPath', 'MethodNotAllowed',
  'ExpiredToken', 'Unregistered', 'PayloadTooLarge', 'TooManyProviderTokenUpdates', 'TooManyRequests', 'InternalServerError',
  'ServiceUnavailable', 'Shutdown',
]);
// Socket error codes worth telling apart.
export const SOCKET_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
]);
const KNOWN_REASONS = new Set(['relay not configured', 'timeout', 'unauthorized', 'rate limited', 'bad request', 'too many new installs today', "couldn't register with the relay", 'send threw', 'fetch failed']);
export function safeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const r = reason.trim();
  if (APPLE_REASONS.has(r) || KNOWN_REASONS.has(r)) return r;
  return r.split(/[^A-Z_]+/).find((w) => SOCKET_CODES.has(w)) ?? 'other';
}
export const failureText = (status: number, reason?: string) => {
  const r = safeReason(reason);
  return `${Number.isFinite(status) ? Math.trunc(status) : 0}${r ? ` ${r}` : ''}`;
};

// One success clears it: some phone is getting them. A send with only
// failures starts or extends the failing run.
export function nextHealth(prev: PushHealth, o: PushOutcome, now: number): PushHealth {
  if (o.sent > 0) return { lastOkAt: now, via: o.via };
  if (o.failed <= 0) return prev;
  return {
    ...(prev.lastOkAt !== undefined ? { lastOkAt: prev.lastOkAt } : {}),
    failingSince: prev.failingSince ?? now,
    lastFailAt: now,
    failed: (prev.failed ?? 0) + o.failed,
    lastFailure: o.failure ?? prev.lastFailure ?? 'unknown',
    via: o.via,
  };
}

export function pushFailing(h: PushHealth | null, now: number): PushFailing | null {
  if (!h || h.failingSince === undefined || h.lastFailAt === undefined || now - h.lastFailAt > PUSH_FAILING_FRESH_MS) return null;
  return { failure: h.lastFailure ?? 'unknown', since: h.failingSince, failed: h.failed ?? 0, via: h.via ?? 'relay' };
}
