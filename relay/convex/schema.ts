// The relay keeps as little as it can: one row per Threadbear install (an
// id, the hash of its key, when it was made and last seen, the app version
// it says it is) and a count of notifications per day. Never a name, a
// thread, a message or a device token. docs/push-relay.md.
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  installs: defineTable({
    installId: v.string(),
    keyHash: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    version: v.optional(v.string()),
    // Sends in the current hour, for the rate limit.
    hourStart: v.number(),
    hourSends: v.number(),
    // The deployment it registered for, checked by calling it back
    // (verify.ts), and how often that deployment registered on that UTC
    // day. None for installs from before the check (5 Nov 2026).
    deployment: v.optional(v.string()),
    registeredDay: v.optional(v.string()),
    registeredToday: v.optional(v.number()),
  })
    .index('by_installId', ['installId'])
    .index('by_deployment', ['deployment']),

  // Anonymous totals per UTC day: notifications forwarded and installs that
  // sent one. What Mike looks at; nothing per install.
  days: defineTable({
    day: v.string(),
    sends: v.number(),
    failed: v.number(),
    registrations: v.number(),
    // Of those, the ones registered without a deployment check, which
    // only happened on 5 Nov 2026 (that way in is gone; kept so old day
    // rows still match the schema).
    legacyRegistrations: v.optional(v.number()),
    // Why the failed ones failed, as "<status> <reason>" (Apple's status
    // and reason, or 0 and the relay's own, like "0 timeout"): the only
    // way to tell a relay problem (its key turned down) from a backend's
    // (a stale token) without logging anything per install. Since 6 Nov
    // 2026, when 65 sends in two days failed and nothing said why.
    reasons: v.optional(v.record(v.string(), v.number())),
  }).index('by_day', ['day']),
});
