# Setup, updates, the phone and Tailscale (design record)

Written 28 Oct 2026 (thread 66935d23) as a proposal, and kept as the record of why
setup and updates work as they do. Most of it is built: section 4 says which steps
are done. For how to set Threadbear up today, read README.md and INSTALL.md; for
what it installs and talks to, docs/on-your-mac.md.

What Mike asked for: setting up Threadbear has you create a Convex deployment
"where everything goes"; a careful think about how updates work and how the iPhone app
fits; Tailscale as the default way things talk to each other; and defaults that suit
Mike, since it's his app first and other people patch their own copy.

## 1. Where things stand

How it works today (file references are in the research notes at the bottom):

- **Install** is two hand-run scripts: `app/install.sh` builds the Mac app, and
  `runner/scripts/install-runner.sh` installs the runner's LaunchAgent. Node is pinned
  to Mike's nvm path, and some defaults are his (`~/dev/me/misc`, `claude-2` for
  Convex work, Token Stats for account limits).
- **Updates** follow the local `main` branch of the checkout. The runner and the Mac app
  both notice when `main` moves and rebuild themselves, and the runner rolls back to its
  last good release after 3 crashes in 10 minutes. Nothing ever fetches from GitHub, so
  a commit on Mike's Mac ships to Mike's Mac, and that's all.
- **Convex** is a cloud deployment in Mike's account, set up by hand in about 8 steps
  (project, `.env.local`, deploy, make a key, `RUNNER_KEY`, `sync.url`, phone token, the
  APNs keys). Functions are deployed by hand and nothing checks that the runner and the
  deployment are on the same version.
- **The phone** only talks to Convex. Pairing is a script that draws a QR code. The app
  only accepts `*.convex.cloud` and `*.convex.site` addresses. Push uses Mike's Apple
  key, which lives in his deployment.
- **The runner** only listens on `127.0.0.1`. Nothing uses Tailscale yet.

## 2. The proposal in one go

Threadbear's backend is a Convex cloud deployment in your own Convex account, so your
phone and your browser keep working when the laptop's shut. Running the backend on
your own machine is an option for people who'd rather, not the default. More goes up
than today's 20-message mirror: every message's text, with the heavy bits (tool output
and images) staying on the Mac. Setup is one command. Updates are your own `main` as
today, plus a way to bring in Mike's changes that an agent does for you and you approve.
There's one App Store iPhone app for everyone, which pairs with any Threadbear backend
and gets notifications through a small relay Mike runs. Tailscale is how your own
machines reach each other: a second runner, a backend you host yourself, and the phone
fetching the heavy bits straight from the Mac when it's awake.

Mike, 28 Oct, on the first draft (which had a self-hosted backend as the default): "we
should encourage cloud and use cloud, but optionally, I guess it could run locally ...
so that you can send your laptop to sleep, but still be able to access stuff from your
mobile phone".

The parts, with the choices that still need Mike:

### 2.1 The backend: Convex cloud, in your own account

**What:** a Convex project in your own Convex account, made by setup (2.2). The runner
writes to it, the phone and the website read it, and it keeps working whatever the Mac
is doing. That's today's arrangement, made automatic and given more to hold.

**What goes up:**

| | Today | Proposed |
|---|---|---|
| Thread list, status, what needs you | Yes | Yes |
| Message text | Newest 20 per thread, older ones on request | All of it |
| Tool calls | No | One line each ("Ran `npm test`", "Edited 3 files") |
| Tool output, diffs, images | No | Stay on the Mac; the phone fetches them over Tailscale when the Mac's awake |

All the text is the part that makes the phone and the website feel complete, and it's
small: the 27 Oct measurement put Mike's conversation text at about 110 MB a month,
against roughly 10 GB for everything, most of it images and tool output. Writes stay
batched and per message, never per token, which is what keeps the bill down (Agent
Archive moved off Convex because of reads and writes, not storage).

**Self-hosted as an option:** the same functions run on Convex's open source backend on
your own machine, served over Tailscale. It's a setting in setup, not a fork. The phone
then needs Tailscale on, and it can't reach a sleeping Mac unless the backend lives on an
always-on machine. Built 7 Nov (docs/self-hosting.md): `setup --self-hosted`, with no
phone notifications, as the push relay only reaches Convex cloud.

### 2.2 Setup: one command

`./threadbear setup` from a clone, written so an agent could also run it:

1. Checks the basics: Xcode command line tools, Tailscale installed and logged in,
   Claude Code or Codex logged in. Downloads its own Node into the data folder rather
   than relying on nvm.
2. Signs you in to Convex (`npx convex login`, once, in the browser), makes a
   `threadbear` project in your account with a production deployment, makes the
   runner's key and sets `RUNNER_KEY`, deploys the functions and the website, and writes
   `runner.json`. A second Mac (`--existing`) gets no Convex login, deploy key or
   `RUNNER_KEY`: the first Mac gives it a runner key of its own with `tb runner add`
   (docs/protocol.md, "Runner keys"). No `.env.local` and no env vars set by hand. With the self-hosted
   option it starts the local backend instead.
3. Builds and installs the runner and the Mac app (today's two scripts, folded together).
4. Opens the Mac app, whose first screen shows a pairing QR code for the phone
   (Settings › Phone, replacing `pair-qr.swift`).

Mike's own defaults stay defaults (misc as the default folder and so on), but move into
`runner.json` with a first-run question or two, so they aren't baked into the code.

### 2.3 Updates: your main, plus Mike's changes when you ask

Everyone has their own fork. `origin` is theirs and `upstream` is `mikecann/threadbear`.
Setup forks it for you (`gh repo fork`, which renames the clone's `origin` to
`upstream`). For Mike they're the same repo. Revised 29 Oct (thread 869a137f) after a
second think, with Mike's answers in section 3.

**Three layers, lowest first.** Every edit to Threadbear's own code is a merge waiting
to happen later, which is how forks usually end up stuck on an old version. So an agent
changing someone's Threadbear uses the lowest layer that does the job:

1. Settings (`runner.json`, the app's Settings): no code.
2. Patches (`.threadbear/patches/`, `~/.threadbear/patches/`): their code, outside
   Threadbear's, which updates never touch.
3. Edits to Threadbear itself: commits on their `main`, merged with Mike's.

**Releases, not Mike's main.** Mike's `main` moves dozens of times a day. Once a day,
Mike's own runner tags the newest commit it has been running as its last good release
for at least six hours, as `release/YYYY-MM-DD`, if anything changed since the last tag.
It also waits until GitHub's checks (the Xcode 26 builds) have passed on that exact
commit, as the runner staying up says nothing about the apps building. Nothing else
pushes main, so the runner pushes a settled main to GitHub first if it isn't there yet. A release held
back says why in `tb status` and the Updates panel, and goes out on the next hourly look
once the checks are green. The tag is signed with Mike's SSH signing key and pushed to GitHub. The tag's message
starts with plain-words notes ("What's new:", a few lines Opus writes from the commits
on Mike's runner, for people who use Threadbear rather than work on it), then lists
every commit since the last tag. The app's Updates panel shows the notes, and the
commit subjects only for a release from before there were notes. If the model call
fails, the release goes out without notes.

**Signed, because it's code that runs as you.** Setup pins Mike's public key
(`scripts/release-signers`) into the data folder. The runner ignores any release tag that
doesn't verify against that pinned copy, so a change to the key in the repo (or a hijacked
GitHub account) can't push code onto everyone's Mac. Only an SSH signature by that key
counts (a PGP or X.509 one never does, whatever gpg would say), a release name keeps the
tag it first verified with, and the bring-in thread merges the commit id that was checked,
not a ref name a later fetch could move.

- **Your own changes ship as they do today.** Commit to `main` (or ask a thread to) and
  the runner and the app rebuild themselves.
- **Mike's changes come in when you say so.** The runner fetches `upstream`'s release
  tags every six hours. When there's a newer signed one, the Updates panel (the updates
  icon at the bottom of the left-hand rail) shows "12 new changes from Mike" with what
  they are. "Bring them in" starts a new thread that merges the tag into your `main`,
  sorts out clashes with your own changes, runs the checks, and asks before it lands
  (docs/bringing-in-updates.md is its brief). Asking is the default (Mike, 29 Oct),
  because a merge can quietly undo something you changed on purpose. Merging by
  itself when nothing clashes and the checks pass could be a setting later.
- **A thread every 5 days, not a nag** (Mike, 6 Nov). Rather than a banner
  or a badge, the runner starts the Bring Them In thread itself every 5 days
  when there's a release waiting (`runner/src/bring-in.ts`). It merges and
  runs the checks before it asks, so it reaches the inbox as one decision.
  Never more than one: a newer release goes to the open thread. A commit of
  Mike's with an `Important: <why>` trailer (a security or data fix) starts
  one straight away. Settings › General › Updates from Mike changes how
  often (a number of days, only important ones, or never).
- **Merging by intent, not just by text.** Git does most of a merge. For the rest,
  the merge thread reads why each side changed (your commits since the last release
  you brought in, and Mike's in the release) and puts your change back onto Mike's new
  code, or drops it when Mike's now does the same thing. It also judges whether a
  release looks halfway through something, and says so before landing.
- **Agents can ask too.** `tb updates` shows the same thing, and `tb updates check`
  fetches now, so a thread that hits a bug can see that Mike's latest release fixes it
  and offer to bring it in.
- **Each release deploys its backend first.** The release pipeline gains a step: deploy
  the Convex functions (and the website) to your backend, then restart the runner. Today
  nothing does this, so a runner can quietly get ahead of its backend.
- **Changes stay compatible both ways.** For a while an older runner, a newer backend and
  a phone app from the App Store all coexist. Schema changes widen first and narrow
  later. The backend reports an `apiVersion` and the phone checks it.

### 2.4 The iPhone app: one app for everyone

People won't build their own phone app, as Mike said, so there's one App Store app and
everything about it has to work with anyone's backend.

- **Pairing:** scan the QR code from the Mac app. It carries the backend's address, a
  token, and the Mac's tailnet name for the heavy bits. The app accepts Convex cloud
  addresses, and `*.ts.net` ones for a self-hosted backend.
- **Connecting:** with the default setup the phone just needs the internet. Tailscale
  only matters for opening tool output and images (2.5) or a self-hosted backend.
- **A stable phone API:** `convex/phone.ts` is a contract between your backend and Mike's
  App Store app. It gets a version number; forks can add to it but shouldn't change
  what's there. The app shows "update Threadbear on your Mac" when a backend is too old,
  and the backend can say which app versions it needs.
- **Notifications:** Apple only accepts pushes for Mike's app signed with Mike's key, so
  a backend that isn't Mike's can't send them itself. The proposal is a small push
  relay that Mike runs as a Cloudflare Worker holding his key. Backends send it a device
  token and an **encrypted** message; the phone decrypts it with a key it got at pairing
  (a Notification Service Extension), so the relay only ever sees gibberish. Mike's own
  backend uses the relay too, so his setup is the same as everyone's.
- **For now (28 Oct 2026):** Mike's call is to ship 1.0 of the App Store app without the relay.
  Pushes keep going straight from his own deployment (`convex/push.ts`, the `APNS_*` env), so
  only a backend holding his key can notify a phone, and the relay comes in a later version.

### 2.5 Tailscale: how your own machines reach each other

With the backend in the cloud, the phone and the browser don't need Tailscale for the
everyday things. Tailscale is the default for everything that's machine to machine:

- **The heavy bits:** tool output, diffs and images stay on the Mac. The runner shares
  them on its tailnet name (`tailscale serve`, HTTPS, tailnet only). On the phone and the
  website each one shows as a grey box of the right size, and loads only as you scroll
  to it, several at once (Mike, 28 Oct). When the Mac's asleep the box says "on your
  Mac" instead.
- **A second runner:** built and supported (section 4, step 7). It writes to the same
  backend and shows up on the phone and the website straight away. This proposal had the
  Mac app reach it over the tailnet; today the first Mac's app reads and steers it through
  Convex, so it needs no Tailscale, and Tailscale only adds the direct link in
  Settings > Runners.
- **A self-hosted backend**, for anyone who picks that option (2.1).
- **Setup checks Tailscale** is installed and logged in, and says what it adds rather
  than refusing.

## 3. What Mike needs to decide

Decided 28 Oct:

- The backend is Convex cloud by default, self-hosted optional (2.1).
- What goes up: all message text plus one line per tool call; tool output and images
  stay on the Mac (2.1).
- The phone and the website fetch tool output and images over Tailscale, lazily, as grey
  boxes that fill in as you scroll (2.5).

- Push relay: Mike runs it, with encrypted messages (2.4). Firebase Cloud Messaging,
  Pusher Beams or OneSignal were considered: they'd still need Mike's Apple key uploaded
  to them, and every user's backend would then hold that service's server key, which can
  send to everyone's phone, so it's the same problem with an extra company in the middle.
  A Worker of Mike's own is smaller and only ever sees encrypted messages.
- Bringing in Mike's changes: from the updates icon on the left-hand rail, "Bring them
  in" starts a new thread you approve (2.3).

Decided 29 Oct:

- Setup forks the repo rather than cloning it.
- Mike's runner tags a release once a day when something changed. Whether a release
  is halfway through a feature is for the merge thread to judge.
- Other people's copies ask before bringing Mike's changes in.

Open: the repo is private (0 forks on 29 Oct), so nobody else can fork it yet. Making
it public is Mike's call, once he's happy for others to use it.

## 4. A rough order to build it in

1. Done 28 Oct: the release pipeline deploys the backend before the runner restarts;
   `apiVersion` in the backend, the runner and the phone (docs/convex-backend.md,
   "Deploying" and "Keeping old and new working together").
2. Done 28 Oct: every message and a one-line row per tool call go up (backend API 2,
   `phone:messages`), each thread's whole history sent once; the website shows whole
   threads with tool calls folded into runs. The iPhone app reads `phone:messages` too
   from the version after 1.0.0 (falling back to API 1's `phone:thread` on an older
   backend).
3. Push relay with encrypted messages, and the phone's notification extension.
4. Done 28 Oct: `./threadbear setup` (scripts/setup.mjs) makes the Convex project in
   your account with a production deployment, the deploy and runner keys, runner.json,
   deploys the backend and website, and installs the runner and the app; tested end to
   end in a sandbox against a new project except the install step. Mike's defaults
   (default folder, account notes, pool folders) moved from the code into his
   runner.json. The pairing QR code and the browser sign-in moved into the Mac app on
   28 Oct (Settings › Phone & browser, docs/protocol.md "Devices"), so setup now points
   there and the terminal scripts are the fallback.
5. Done 29 Oct: Mike's releases. His runner tags a signed `release/<date>` once a
   day (runner.json `releases`); a fork's runner fetches and checks them
   (runner/src/upstream.ts, docs/protocol.md "Mike's releases"); the Updates panel's
   From Mike section and `tb updates` show what's new; Bring Them In starts the merge
   thread (docs/bringing-in-updates.md); `tb land` never rebases a merge; setup forks
   and pins the key.
6. The heavy bits over Tailscale for the phone and the website.
7. Done 29 Oct: a second runner on the same backend, on Bruce rather than Tinker Desk.
   Each one has its own key since 5 Nov (docs/protocol.md, "Runner keys"). Any number of
   Macs or Linux servers can join: INSTALL.md sets them up.
8. Done 7 Nov: self-hosted backend as a setup option (`setup --self-hosted`,
   docs/self-hosting.md). Docker on the same Mac, served with `tailscale serve`,
   phone notifications off. Convex cloud stays the default and the one we
   recommend everywhere.

Steps 1 and 2 are useful to Mike straight away. 3 to 5 are what make it installable by
other people. The landing page already says "Threadbear makes a Convex deployment in
your own Convex account", which this now matches once step 4 is built.

## A Mac nobody sits at

Before leaving a second Mac on its own, turn on Threadbear Runner in System
Settings > Privacy & Security > Full Disk Access there (add
`~/Applications/Threadbear Runner.app` with the + if it isn't listed). No program
can do this for you. Without it, an agent touching Desktop, Documents, Downloads
or a removable drive leaves a macOS prompt waiting, and it can hold up every
other app using that drive until someone answers. That
goes for a fork and an own-deployment install as much as Mike's.
`install-runner.sh` says this at the end of an install and opens the pane on a
Mac without the app, `tb status` says while it's missing, and a Mac without the
app gets a thread about it (docs/protocol.md, "A dialog on a Mac's screen").

## Research notes

How things work today, from a read of the repo on 28 Oct:

- Install: `app/install.sh` (checks swift and python3, runs `setup_mac.sh`, which runs
  `build-app.sh`); `runner/scripts/install-runner.sh` (main's tip only, not from inside a
  thread, Node 24 at the nvm path, writes the LaunchAgent, first release through
  `deploy.mjs`). Since 28 Oct the LaunchAgent's program is `~/Applications/Threadbear
  Runner.app` (`runner/launcher/`), which runs `node launch.mjs` as its child, so macOS's
  privacy prompts name Threadbear Runner rather than node (seen on Tinker Desk's first
  thread: "'node' wants to access files managed by Dropbox").
- Runner updates: `runner/src/update.ts` (every 5 minutes and on ref changes, clones from
  the local checkout's `refs/heads/main`, builds when the runner's tree changed, idle
  restart); `runner/launch.mjs` (rollback to `lastGood` after 3 bad boots in 10 minutes).
- App updates: `app/Sources/Threadbear/AppUpdate.swift` and `app/stage-update.sh` (same
  local-main model, swaps the bundle on quit or launch).
- Convex: `convex/lib.ts` (`RUNNER_KEY`), `runner/src/sync.ts` (`sync.url` and
  `secrets/convex-key`), `convex/push.ts` (`APNS_*` env), docs/convex-backend.md.
- Phone: `ios/ThreadbearKit/Sources/ThreadbearKit/Pairing.swift` (only `*.convex.cloud`
  and `*.convex.site`), `ios/scripts/pair-qr.swift`, `ios/scripts/install-phone.sh`
  (Mike's phone and App Store Connect key).
- Network: `runner/src/config.ts` binds `127.0.0.1`; docs/convex-backend.md section 2
  ruled out the phone talking to the runner directly because the Mac sleeps.
