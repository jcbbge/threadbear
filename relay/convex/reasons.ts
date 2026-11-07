// Plain TypeScript with no Convex imports, so the runner's unit tests can
// check it (runner/test/unit/push-health.test.ts).

// A failure's tally key: Apple's status and reason word, cut down so a
// strange body from Apple (or a socket error's text) can't grow the row.
// Never a device token: reasons are fixed words or error messages.
// Apple's documented reasons (developer.apple.com, "Handling notification
// responses from APNs"); keep in step with convex/pushHealth.ts.
export const APPLE = new Set([
  'BadCollapseId', 'BadDeviceToken', 'BadExpirationDate', 'BadMessageId', 'BadPriority', 'BadTopic',
  'DeviceTokenNotForTopic', 'DuplicateHeaders', 'IdleTimeout', 'InvalidPushType', 'MissingDeviceToken', 'MissingTopic',
  'PayloadEmpty', 'TopicDisallowed', 'BadCertificate', 'BadCertificateEnvironment', 'ExpiredProviderToken', 'Forbidden',
  'InvalidProviderToken', 'MissingProviderToken', 'UnrelatedKeyIdInToken', 'BadEnvironmentKeyInToken', 'BadPath', 'MethodNotAllowed',
  'ExpiredToken', 'Unregistered', 'PayloadTooLarge', 'TooManyProviderTokenUpdates', 'TooManyRequests', 'InternalServerError',
  'ServiceUnavailable', 'Shutdown',
]);
// Socket error codes worth telling apart.
export const SOCKET = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
]);
// Only those and the relay's own few are kept, as anything else (a
// socket error's message) could carry anything. The rest is "other".
const OWN = new Set(['relay not configured', 'timeout', 'send threw']);
export function reasonKey(status: number, reason?: string): string {
  const r = (reason ?? '').trim();
  const word = !r ? '' : APPLE.has(r) || OWN.has(r) ? r : (r.split(/[^A-Z_]+/).find((w) => SOCKET.has(w)) ?? 'other');
  const code = Number.isFinite(status) ? Math.trunc(status) : 0;
  return word ? `${code} ${word}` : String(code);
}
// Different reasons kept per day; past that they all go under "other".
export const MAX_REASONS = 20;
