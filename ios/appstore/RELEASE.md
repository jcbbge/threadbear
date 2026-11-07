# Releasing Threadbear for iPhone

Every step to "Submitted for review", copied from Walkies' runbook
(`~/dev/me/walkies/docs/runbooks/appstore-release.md`, same team and API key). Run everything from
the repo root.

## What Mike decided (28 Oct 2026)

- **Free**, **iPhone only**, **worldwide**, version **1.0.0**, released **manually** once approved.
- **No push relay in 1.0.** Pushes go straight from Mike's own deployment (`convex/push.ts`, the
  `APNS_*` env); the relay in `docs/setup-and-updates.md` 2.4 comes later.
- App Review uses the **demo** ("Look around with sample threads" on the pair screen, `FakeBackend`),
  never a token into a real deployment.
- Support email `threadbear@mikecann.app` (a Cloudflare Email Routing forward, like walkies@).
  Privacy and help pages: https://threadbear.mikecann.app/privacy and /support (`site/`).

The App Store Connect app is **Threadbear**, bundle `com.mikecann.threadbear`, primary language
English (Australia). The scripts find it by bundle id. They use the team's Admin API key
`~/.config/poddle/AuthKey_7SS6J9F98P.p8`; never print it. The review contact's phone comes from
`~/.config/poddle/review-contact.json`.

## 1. Before you start

- `swift test` in `ios/ThreadbearKit` passes (it checks the sample threads name nothing of Mike's).
- `ios/appstore/metadata.json` has been read and okayed by Mike.
- The privacy and support pages load.

## 2. The listing

```sh
node ios/scripts/appstore-metadata.mjs --dry-run
node ios/scripts/appstore-metadata.mjs
```

Content rights, categories (Developer Tools, then Productivity), name, subtitle, privacy URL,
version 1.0.0, copyright, manual release, description, keywords, promotional text, support and
marketing URLs, age rating, free, worldwide, and the App Review contact and notes.

## 3. Screenshots

6.9" iPhone, 1320 x 2868, on the sample threads only:

```sh
SIM_NAME="Threadbear App Store" ios/scripts/sim-shots.sh ios/appstore/screenshots
node ios/scripts/appstore-screenshots.mjs ios/appstore/screenshots/{inbox,approval,question,new-thread}.png
```

Look at each one first. They're not committed.

## 4. Build and upload

```sh
ios/scripts/appstore-upload.sh            # archive, export, validate; no upload
UPLOAD=1 ios/scripts/appstore-upload.sh   # the real thing; note the build number
node ios/scripts/appstore-submit.mjs <build>   # waits for processing, attaches it, manual release
```

With `UPLOAD=1` the script skips `altool --validate-app`, as the upload validates the build
itself (on 7 Nov altool sat silent for 8+ minutes; the upload took two). `VALIDATE=1` runs it
anyway, and it's stopped with a warning after `VALIDATE_TIMEOUT` seconds (300). If a run stopped
after archiving, `UPLOAD=1 BUILD_NUMBER=<build> ios/scripts/appstore-upload.sh` uploads the archive
already in `/tmp/threadbear-appstore/<build>` without building it again.

The upload script refuses an archive that mentions a Convex deployment, has the Debug-only launch
arguments, isn't on production APNs or has no privacy manifest.

## 5. Only in App Store Connect

- **App Privacy**: from the version after 1.0.0, Diagnostics > Crash Data, not linked to the
  user, not used for tracking, for App Functionality: App Store builds send anonymous crash
  reports to Sentry (`Threadbear/CrashReporting.swift`). Nothing else is collected; the app only
  talks to the person's own deployment. Publish. (1.0.0 went in as Data Not Collected, before
  Sentry.)
- **App Information > Regulated Medical Device**: not a medical device (Walkies was asked for this
  on resubmission, Oct 2026).
- **Age Rating**: any questions `appstore-metadata.mjs` lists as unanswered; all none, no kids band.

## 6. Check, then submit

```sh
node ios/scripts/appstore-submit.mjs --check            # lists anything missing, changes nothing
node ios/scripts/appstore-submit.mjs <build> --submit   # only once Mike says go
```

After a rejection: fix, `UPLOAD=1 ios/scripts/appstore-upload.sh` (new build number, same 1.0.0),
then `--submit` again; it resubmits the rejected submission, which App Store Connect's own button
sometimes won't.

## Once it's approved

Release it once Mike says to: `node ios/scripts/appstore-release.mjs <version> --release` (without
`--release` it only says where review is up to), or the button in App Store Connect. Then in `site/site.mjs` set `APP_STORE_URL` to
`https://apps.apple.com/app/id<Apple ID>` and `APP_STORE_LIVE` to `true`, and `npm run deploy` in
`site/`.
