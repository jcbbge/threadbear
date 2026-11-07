# Self-hosting Threadbear's backend

Use Convex cloud if you can. It's setup's default and the one we recommend:
it keeps working while your Mac sleeps, sends phone notifications, and needs
nothing else installed. Self-hosting runs Convex's open source backend in
Docker on your Mac instead, and you lose:

- **Phone notifications.** The push relay only calls back to Convex's own
  hosts to check a backend is real (`relay/convex/verify.ts`), so setup turns
  pushes off (`PUSH_RELAY=off`). The phone's Settings, the Mac's Phone &
  browser and `tb status` say so.
- **The phone without Tailscale.** The backend is only on your tailnet.
- **Anything while the Mac sleeps** or Docker is stopped.
- **Share links for people off your tailnet.**

The user guide's "Self-hosting your backend" section is the short version
for people using it. This is how it's put together. Built 7 Nov 2026, after
someone asked on X; tested end to end on Tinker Desk (Docker Desktop,
Docker 27.4, Tailscale 1.104).

## Setting it up

You need Docker Desktop or OrbStack (set to start at login, as the backend
stops with it), and Tailscale logged in with MagicDNS and HTTPS
certificates on for the tailnet. Then:

```sh
./threadbear setup --self-hosted --yes
```

Partway through, macOS may ask whether Terminal can "access data from other
apps". Setup doesn't need it, and Don't Allow is fine: that's what the 7 Nov
recording did.

Running setup again later doesn't need the flag: the admin key file says
this Mac is self-hosted. A Mac already set up with Convex cloud is refused,
as setup doesn't move a Threadbear between backends.

## What setup makes

`scripts/setup.mjs`, "a self-hosted backend":

| | |
|---|---|
| `threadbear-convex` | the backend container, `ghcr.io/convex/convex-backend` at a pinned tag (`CONVEX_IMAGE_TAG`) |
| `threadbear-convex-dashboard` | the dashboard container, the same tag |
| `threadbear-convex-data` | the Docker volume with everything in it: the SQLite database, stored files, and the instance secret (`/convex/data/credentials`) |
| 127.0.0.1:13210, 13211, 16791 | the API, the site and the dashboard, on loopback only. Not 3210: that's where `npx convex dev` runs a local deployment |
| `tailscale serve` on 3210, 3211, 6791 | the same three on `https://<mac>.<tailnet>.ts.net`, for the tailnet only. Port 443 is left alone, as people often serve something else there |
| `secrets/convex-self-hosted.env` | `CONVEX_SELF_HOSTED_URL` (the loopback API) and `CONVEX_SELF_HOSTED_ADMIN_KEY`, quoted so a shell can source it |
| runner.json `sync.url`, `sync.site` | the tailnet API and site addresses |
| `PUSH_RELAY=off`, `RUNNER_KEY` | the backend's only env vars |

Two things it has to get right, each found by trying it:

- **The origins must reach the backend from inside the container too.**
  The static-hosting component serves the website by fetching its own stored
  files through `CONVEX_CLOUD_ORIGIN`. With the origin left at the compose
  file's `http://127.0.0.1:<port>`, every page was a 500 ("connection
  refused"), as that port is the host's, not the container's. So the origins
  are the tailnet addresses, and the container gets
  `--add-host <mac>.<tailnet>.ts.net:<the Mac's tailnet IP>`; Docker Desktop
  then routes it out through the Mac to `tailscale serve`.
- **No `--prod` on a self-hosted backend.** The Convex CLI refuses it there
  ("cannot be used with a self-hosted deployment"), so the website upload
  leaves it off (`prodArgs` in `runner/src/convex-admin.ts`).

## Keys

`runner/src/convex-admin.ts` reads which admin credential this Mac has (a
cloud deploy key or the self-hosted admin key, never both) and builds the
env for every Convex CLI call: setup, `runner/scripts/deploy-backend.mjs`
and `tb runner rotate-owner`.

Every admin key is made from the backend's instance secret, so none can be
listed or revoked on its own. `tb runner check` counts the admin key file as
an admin credential, like a deploy key, and `rotate-owner` says it can't list
them. If one leaks, the way out is a new instance secret, which ends every
admin key at once.

A second Mac joins as it would with cloud: `setup --existing` there, then
`tb runner add <name> --ssh <host>` on this Mac, which also writes
`sync.site` into its runner.json.

## The phone and the website

- The iPhone app pairs with `https://<name>.ts.net:<port>` as well as Convex
  cloud addresses (`ios/ThreadbearKit Pairing.swift`), asking first as
  always. That needs an iPhone app newer than 1.0.4.
- It doesn't ask for notification permission on a backend that says
  `pushOff`, as there'd be nothing to send.
- The Mac app takes the website's address from `runner.status`'s
  `sync.site`, falling back to the `.convex.site` twin for cloud.
- `phone:me` and the owner's heartbeat answer `pushOff: true`
  (`convex/pushHealth.ts`).

## When it won't come up

Run setup again (`./threadbear setup`, no flag needed). It starts anything
that's stopped, and makes a container again if it won't start or its
settings have changed, always on the same volume, so your data stays. After
Docker Desktop was stopped uncleanly on Tinker Desk, the old backend
container failed with "failed to start shim ... file exists" until setup
made it again.

## Backing up, upgrading, taking it out

Everything is in the `threadbear-convex-data` volume. To back it up, export
with the Convex CLI using the admin key (`npx convex export`, with the
variables from `secrets/convex-self-hosted.env` set).

The image tag is pinned because an upgrade can need an export and an import
(Convex's `self-hosted/advanced/upgrading.md`). Move `CONVEX_IMAGE_TAG` on
deliberately; setup then makes the containers again on the same volume.

To take it out: `docker rm -f threadbear-convex threadbear-convex-dashboard`,
`docker volume rm threadbear-convex-data` (this deletes your threads'
mirror), `tailscale serve --https=3210 off` (and 3211, 6791), and delete
`secrets/convex-self-hosted.env` and `sync.url` and `sync.site` from
runner.json.

## The setup video

`scripts/record-self-hosted-install.sh` records an agent doing the whole
install from the website's prompt on a clean Mac's desktop (Mike's is Tinker
Desk, through `desk`), and `scripts/remove-self-hosted-install.sh --yes`
takes it all out again, so it can be recorded again whenever setup changes.

The recording has to start with no prompts in the way, so the script runs the
agent in an empty folder with GitHub logged out and its permissions named, in a
full-screen Terminal. Claude Code hides setup's output, so the video's list of
steps comes from running `./threadbear setup` again afterwards, in that Terminal.
