// Phone notifications failing, as the backend's heartbeat reports it
// (convex/pushHealth.ts), for tb status and the app's notice (sync.ts).
// Its own module so tb doesn't load the sync engine to print it.

export type PushFailing = { failure: string; since: number; failed: number; via: 'apple' | 'relay' };

export function asPushFailing(v: unknown): PushFailing | undefined {
  const p = v as Partial<PushFailing> | null | undefined;
  if (!p || typeof p.failure !== 'string' || typeof p.since !== 'number' || typeof p.failed !== 'number') return undefined;
  return { failure: p.failure.slice(0, 200), since: p.since, failed: p.failed, via: p.via === 'apple' ? 'apple' : 'relay' };
}

// What tb status and the app say while pushes fail. Apple turning a key
// down is the key's owner's to fix: the relay's is Mike's, a backend's own
// is in its APNS_* env.
export function pushFailingText(p: PushFailing): string {
  const since = new Date(p.since).toISOString().slice(0, 16).replace('T', ' ');
  const head = `Phone notifications aren't getting through: ${p.failed} failed since ${since} UTC, the last with ${p.failure}.`;
  const keyRefused = /InvalidProviderToken|ExpiredProviderToken|MissingProviderToken|BadCertificate/.test(p.failure);
  if (p.via === 'relay') {
    return keyRefused
      ? `${head} Apple turned down the push relay's key, which only Mike can fix: say so at https://github.com/mikecann/threadbear/issues if it lasts.`
      : `${head} They go through the push relay (docs/push-relay.md); npx convex logs on this backend has each one.`;
  }
  return keyRefused ? `${head} Apple turned down this backend's own push key: check APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID in its Convex env.` : `${head} npx convex logs on this backend has each one.`;
}

