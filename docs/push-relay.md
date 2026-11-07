# The push relay

The one shared piece of Threadbear. Built 28 Oct 2026 (thread 66935d23);
the decisions are in docs/setup-and-updates.md section 2.4.

## Why it exists

Apple only delivers a notification to the App Store app if it's signed with
the key of the developer account that published it: Mike's. That key also
signs for his other apps, so it can't go into other people's Threadbear
backends. The relay is a small Convex project of Mike's that holds the key
and forwards notifications for them. Everything else in Threadbear runs on
each person's own Mac and their own Convex deployment.

## What it sees, and what it keeps

- **Sees:** a device token, whether it's a development or App Store install,
  a thread id (a random UUID), and the notification **sealed** with a key
  only that phone and its own backend have. It never sees the title or text.
- **Keeps:** one row per Threadbear install (a random id, the hash of its
  key, when it was made and last seen, the version it says it is, and for
  backends from 5 Nov 2026 the address of the Convex deployment it
  registered for) and daily totals (notifications sent and failed, why
  the failed ones failed as Apple's status and reason word, new
  installs). No device tokens, no thread ids, nothing per notification.
- **Opting out:** `npx convex env set PUSH_RELAY off` on your deployment. Then
  nothing goes to the relay, and the phone gets no notifications (they'd have
  to come from somewhere). Mike can forget an install:
  `npx convex run relay:forget '{"installId":"i_..."}' --prod` in `relay/`.

## How a notification travels

1. The phone makes 32 random bytes the first time (`PushKeyStore`, in the
   keychain under an App Group its notification extension shares) and sends them to its
   own backend with `phone:registerDevice` (API 4), never anywhere else.
2. When a thread needs Mike, `convex/push.ts` seals `{title, body}` with that
   phone's key (AES-256-GCM: nonce, ciphertext, tag, base64) and posts it to
   the relay's `/send` with the backend's install id and key (registered once
   through `/register` and kept in the `relayInstall` table; see
   "Registering" below).
3. The relay sends Apple a stand-in ("Threadbear: A thread needs you") with
   `mutable-content` and the sealed text in `e`.
4. The app's notification extension (`ios/NotificationService`) opens `e`
   with the key and shows the real title and text. If it can't, the stand-in
   shows.

A backend with its own Apple key (`APNS_*` env: Mike's) sends directly and
skips the relay. `PUSH_VIA=relay` sends through the relay anyway, for testing.

## Registering

`/register` is open to anyone, so it can't simply hand out installs from
one shared daily allowance: a script used to be able to use all 500 up and
stop every new backend from getting notifications (Daybreak scan, 5 Nov
2026). Callers can't be told apart by address either, since every backend
calls from Convex's servers. So a backend from 5 Nov sends its own
deployment address (`CONVEX_SITE_URL`) and a random nonce, which it also
keeps in its `relayChecks` table. The relay posts `{ nonce }` to that
deployment's `/relay/verify` (`convex/http.ts`), which says yes only to a
nonce it made in the last five minutes, once. Only someone running the
deployment passes, so each deployment gets one install (registering again
gives it a new key) and nobody can use up anyone else's. The relay only
calls back to `https://<name>[.<region>].convex.site`.

There's no unchecked way in. Backends from before 5 Nov 2026 used one,
with a shared daily allowance anyone could use up, and it went the same
day (the relay's only install then was Mike's, which kept working:
`/send` never asks how an install was made). So an older backend that
needs a new install has to update, and a backend not on Convex's own
hosts (self-hosted, a custom domain) can't use this relay: run your own
(it's `relay/`, with your own Apple key). The code is
`relay/convex/verify.ts` and `relay.ts`.

## The project

- Code: `relay/` (its own package and `convex/`). Convex project
  `threadbear-relay` on team mikec: prod `impartial-hound-393` (Sydney,
  `https://impartial-hound-393.ap-southeast-2.convex.site`), dev
  `clean-terrier-424`. Env: the same `APNS_*` as Threadbear's prod.
- Limits: 120 sends an hour per install; 20 registrations a day per
  deployment.
- Stats for Mike: `npx convex run relay:stats --prod` in `relay/`. Each
  day's `reasons` tallies the failures as `"<status> <reason>"` (since 6
  Nov 2026), and the relay's own log has a `[send] failed:` line for each
  (status and reason only). `versions` counts installs by the version
  their backend says (`api-52`), which anyone with an install can set:
  it's stored only if it's a plain word (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/`,
  else `unknown`) and counted in a Map, with anything stored before that
  rule as `other`, since one `$x`, `é` or `toString` broke the query
  for good (6 Nov 2026).
- Its Apple key is Poddle's (same team, so it signs for any of Mike's
  apps). Poddle moved to a new key and the old one was revoked, and from
  5 Nov 2026 every send failed with `403 InvalidProviderToken` until 6 Nov,
  when the relay and Threadbear's prod got the new key. If Poddle's key
  changes again, copy `APNS_KEY_P8` and `APNS_KEY_ID` to both. To check a
  key without a real phone: `npx convex run apns:send
  '{"deviceToken":"<64 zeros>","environment":"production","threadId":"probe"}' --prod`
  in `relay/` answers `400 BadDeviceToken` when Apple takes the key.
- A backend hears when its pushes stop getting through: each send's
  outcome goes in its `pushHealth` row (`convex/pushHealth.ts`), and the
  owner runner's heartbeat carries `pushFailing` to `tb status` and a
  notice in the app (docs/protocol.md, "Sync").
- Deploy: `npm ci` then `npx convex deploy` in `relay/`, signed in to the
  Convex CLI as Mike (it isn't part of the runner's backend deploy, which
  is for each person's own deployment).
