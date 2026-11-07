# Installing Threadbear (for an agent)

You're an agent (Claude Code, Codex or similar) installing Threadbear on the
Mac you're running on, for the person you're working with. Follow these steps
in order. Stop and ask them at the points marked **Ask**; everything else you
can do yourself. `README.md` says what Threadbear is.

## 1. Check the Mac

Run these and fix what's missing before going on:

- `sw_vers -productVersion` and `uname -m`: macOS on `arm64` (Apple silicon).
- `xcodebuild -version`: Xcode 26 or newer. If it's missing or older, **Ask**
  them to install Xcode from the App Store and open it once, then carry on.
- `node -v`: 24 or newer. If not, install it with nvm
  (`nvm install 24 && nvm use 24`) or Homebrew (`brew install node@24`), and
  use that `node` for the rest.
- Claude Code (`~/.local/bin/claude` or `claude` on the PATH) or Codex
  (`codex`): one of them installed and logged in. You're probably running in
  one of them already.
- `launchctl print gui/$(id -u) >/dev/null && echo yes`: says `yes` when
  someone is logged in to the desktop. The runner only starts for a desktop
  login, so if it says nothing, **Ask** them to log in to the Mac's desktop.

## 2. Get the code

If you aren't in a copy of the repo already, fork it rather than cloning
it, so their changes have a home of their own and Mike's updates can still
come in:

```sh
cd ~ && gh repo fork mikecann/threadbear --clone
```

If `gh` isn't logged in (`gh auth status` fails, which an expired login
does too), run `gh auth login --web` and **Ask** them to approve it in the
browser. If they'd rather not use GitHub, a plain
`git clone https://github.com/mikecann/threadbear ~/threadbear` works too:
setup then makes Mike's repo their `upstream`, and they can fork later.
Work from `~/threadbear` from here on.

## 3. Run setup

Look first, without changing anything:

```sh
./threadbear setup --dry-run --yes
```

**Ask** them, in one message:

- whether this Mac is joining a Threadbear they already have on another Mac
  (then: the name of that Convex project),
- otherwise, what to call their new Convex project (default `threadbear`),
- and if the dry run said their Convex login has several teams, which team
  it goes in (pass it as `--team <slug>`).

Then run it, with their answers:

```sh
./threadbear setup --yes --project <name>
# joining an existing project instead:
./threadbear setup --yes --existing --project <name>
```

**Only if they ask to self-host** (keep their threads off Convex cloud):
say first that we recommend Convex cloud, and that self-hosting means no
phone notifications, the phone needing Tailscale on, nothing working while
this Mac sleeps, and share links only opening on their tailnet
(docs/self-hosting.md). If they still want it, check `docker info` works
(**Ask** them to install and start Docker Desktop or OrbStack if not) and
that `tailscale status` shows this Mac logged in (**Ask** them to install
and log in to Tailscale if not). Then, in place of the commands above:

```sh
./threadbear setup --self-hosted --dry-run --yes
./threadbear setup --self-hosted --yes
```

No Convex login or team is needed. If it stops asking for HTTPS
certificates or MagicDNS, **Ask** them to turn those on in the Tailscale
admin console (DNS), then run it again.

If your own permission check refuses to run setup (Claude Code's auto mode
does: it's a script you've just downloaded), that's its job, so don't try to
get round it. **Ask** them to allow it, by running the command themselves
with `! ` in front or by adding a permission rule for `./threadbear setup`,
then carry on from what it printed.

New threads start in `~/ThreadbearThreads`, which setup makes (not
`~/Threadbear`: macOS ignores case, so that would be this repo's folder).
They can change it in the app's Settings, and pick a folder for each
thread as they start it.

It takes a few minutes (it builds the Mac app). Along the way:

- If they aren't logged in to Convex, it opens a Convex page in the browser
  and waits. **Ask** them to approve it (and to make a free account if they
  haven't got one).
- If their Convex login has several teams, it stops and lists them. **Ask**
  which one, and run it again with `--team <slug>`.
- Any other stop says what's wrong; fix it and run the same command again. It
  carries on from where it got to.

It finishes with "Threadbear is set up." Then open the app:
`open ~/Applications/Threadbear.app`.

Setup also puts `Threadbear Runner.app` in `~/Applications`. It's the small
program that runs the runner in the background; it isn't for opening. When
an agent in a thread first reads a protected folder (Desktop, Documents,
Downloads, iCloud or Dropbox), macOS asks whether to let "Threadbear Runner"
do that. Tell them that prompt is Threadbear's, so they can answer it.

## 4. The phone and the browser

Both happen in the app, in Settings (⌘,) › Phone & browser. **Ask** them to
open it there:

- "Show the code" shows a QR code to scan with the Threadbear iPhone app.
- "Open signed in" opens their Threadbear website in their browser, signed in.
- The same tab lists what's paired, each with Revoke.

The terminal scripts still work when there's no app window to hand
(`npm run web:sign-in`, and `swift ios/scripts/pair-qr.swift --prod --url
<the URL setup printed>`), but never show or print a pairing link or token
yourself: it can run their agents.

## 5. Tell them it's done

Say what was set up (their Convex project and its URL, where the app is), and
that the runner and app update themselves when their `main` changes.

## Another Mac (optional)

Running Threadbear on several machines is supported, for example a laptop and a
Mac mini that's always on. Each runs its own threads in its own folders, and
project files aren't copied between them. To add a Mac, follow this file on it
and say yes to joining (`setup --existing`), then on the first Mac run
`tb runner add <name> --ssh <that Mac>` and `tb restart` on the new one. (With no
ssh between them, `--out <file> --id <runnerId>` writes the key to a file, which
goes in the new Mac's `secrets/convex-key`.) Only the first Mac's app lists every
machine's threads, so that's best as the Mac they sit at; the phone and website
show them all. The guide's "If you run Threadbear on more than one Mac" has the
rest, and `docs/setup-and-updates.md`, "A Mac nobody sits at", covers one left on
its own.

## 6. A runner on Linux (optional)

Once Threadbear works on the Mac, a Linux server can be a second, always-on
runner, like a second Mac: its threads show in the Mac app's sidebar and on
the phone, and the composer's machine chip starts threads there. It runs the
runner only, no app. Ubuntu 24.04 on x86_64 is what's been tried, on a
Hetzner cloud server with 8 GB. Do this as an ordinary user with sudo, not root.

1. **Packages:** `sudo apt-get install -y git build-essential imagemagick
   librsvg2-bin bubblewrap jq lsof` (ImageMagick and rsvg-convert stand in for
   macOS's sips and Quick Look when pictures are converted; Codex's sandbox
   wants bubblewrap; lsof checks who's on the other end of a handover's
   socket, and minimal images leave it out). zsh isn't needed: patch
   commands run in the account's own shell, else bash. Set the account's full name, which agents are told:
   `sudo chfn -f "Their Name" $USER`. And a git identity, as on any machine
   that commits: `git config --global user.name` and `user.email`.
2. **Node 24 with nvm**, at the path the scripts expect:
   `nvm install 24.22.1` (else pass `--node` to the install script).
3. **The CLIs, logged in on this server:** Claude Code with its native
   installer (`curl -fsSL https://claude.ai/install.sh | bash`, which puts
   it in `~/.local/bin/claude`, where the runner looks), then
   `claude auth login`; Codex with `npm i -g @openai/codex`, then
   `codex login --device-auth`. Both print a link for them to open in their
   own browser. Never copy credentials over from the Mac.
4. **Tailscale:** install it and `sudo tailscale up --hostname=<name>`, and
   **Ask** them to open the link it prints. Once it's on their tailnet, close
   the server's public SSH port in the cloud's firewall and use the tailnet
   name instead.
5. **The code:** clone their fork to `~/dev/me/threadbear` (any folder
   works) and, in `runner/`, `npm ci`.
6. **Join their backend:** copy `secrets/convex-key` from the Mac's data
   folder to the same place here (`~/Library/Application Support/Threadbear`;
   the folders keep their macOS names on Linux, so every path in these docs
   is the same) with `scp`, never by printing it, and `chmod 600` it. Then
   write `runner.json` there: `port` 8797, and `sync` with `url` (the Mac's
   `sync.url`), `name` (what the sidebar calls this machine) and `rpcUrl`
   (`wss://<tailnet name>:8798/rpc`).
7. **Install:** `runner/scripts/install-runner.sh`. On Linux it writes a
   systemd user service, `~/.config/systemd/user/com.mikerosoft.threadbear.runner.service`,
   in place of the LaunchAgent. Turn on lingering once, or it stops when
   nobody is logged in: `sudo loginctl enable-linger $USER`.
8. **Reach it from the Mac:** `sudo tailscale serve --bg --https=8798
   http://127.0.0.1:8797` here, then `tb pair` here prints the two files to
   copy to the Mac.
9. **Updates:** the runner follows its checkout's `main` like the Mac's
   does, so keep that checkout pulling theirs: a systemd user timer that runs
   `git -C <checkout> pull --ff-only` every few minutes.

**Without a checkout on the server**, the way T3 Code ships its server:
after steps 1 to 3 (no Tailscale needed), run
`runner/scripts/deploy-remote.sh <ssh host>` on the Mac. It builds a release
from the Mac's checkout, copies it over ssh, runs `npm ci --omit=dev` there,
and writes `runner.json` (with `followMain` off) and the systemd unit. Then
run `tb runner add <name> --ssh <host>` once for its key, and the script
again to start it. Nothing on the server pulls from git: to update it, run
the script again from the Mac. Its header says how to take it all out.

What's left out on Linux: everything that needs a Mac, such as the iOS
simulator, Xcode, BrowserBear, ComputerCub and noticing dialogs on the screen.
Threads that need those belong on the Mac.
