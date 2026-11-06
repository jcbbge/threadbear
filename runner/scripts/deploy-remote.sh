#!/bin/bash
# Ships this checkout's runner to another machine over ssh, the way T3 ships
# its server: a built release and a systemd user service there, and no git
# checkout. The machine then shows in the Mac app's machine chip like any
# other runner, and its threads run there.
#
#   scripts/deploy-remote.sh <ssh host> [--name NAME] [--node PATH]
#
# Run it again to ship a new release; nothing on the other machine pulls
# from git (followMain is off there). The first run also writes its
# runner.json; then run `tb runner add <name> --ssh <host>` once for its key.
#
# What it needs there: Linux with systemd, Node 24, and claude and/or codex
# logged in. What it puts there, all under the default data dir
# (~/Library/Application Support/Threadbear, the name the runner uses on
# Linux too):
#   runner/releases/<id>/   the release, with npm ci --omit=dev run there
#   runner/current          -> releases/<id>
#   runner/launch.mjs       what the service starts
#   runner.json             only when it's missing
#   ~/.config/systemd/user/com.mikerosoft.threadbear.runner.service
#
# To take it all out again, on that machine:
#   systemctl --user disable --now com.mikerosoft.threadbear.runner.service
#   rm ~/.config/systemd/user/com.mikerosoft.threadbear.runner.service
#   rm -rf ~/Library/Application\ Support/Threadbear
# and on the main Mac: tb runner revoke <runnerId> --purge
set -euo pipefail

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }

HOST=""
NAME=""
REMOTE_NODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:?--name needs a name}"; shift ;;
    --node) REMOTE_NODE="${2:?--node needs a path}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$HOST" ] || { echo "One host at a time." >&2; exit 2; }; HOST="$1" ;;
  esac
  shift
done
[ -n "$HOST" ] || { usage >&2; exit 2; }
NAME="${NAME:-$HOST}"

RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(git -C "$RUNNER_DIR" rev-parse --show-toplevel)"
PREFIX="$(git -C "$RUNNER_DIR" rev-parse --show-prefix)"
PATHS=(src bin package.json package-lock.json launch.mjs)

# A release is HEAD's files, so uncommitted changes to them would be left out
# without anyone noticing.
if [ -n "$(git -C "$RUNNER_DIR" status --porcelain -- "${PATHS[@]}")" ]; then
  echo "The runner has uncommitted changes; commit them first, since a release is HEAD's files." >&2
  exit 1
fi

COMMIT="$(git -C "$RUNNER_DIR" rev-parse HEAD)"
SHORT="$(git -C "$RUNNER_DIR" rev-parse --short HEAD)"
BRANCH="$(git -C "$RUNNER_DIR" rev-parse --abbrev-ref HEAD)"
ID="$(date -u +%Y%m%dT%H%M%SZ)-$SHORT"

# The backend this Mac syncs to, for a first runner.json there.
LOCAL_JSON="${THREADBEAR_HOME:-$HOME/Library/Application Support/Threadbear}/runner.json"
SYNC_URL="$(node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sync?.url ?? "") } catch {}' "$LOCAL_JSON")"
[ -n "$SYNC_URL" ] || { echo "No sync.url in $LOCAL_JSON, so there's no backend for $HOST to join." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/release"
git -C "$ROOT" archive --format=tar HEAD -- "${PATHS[@]/#/$PREFIX}" \
  | tar -x -C "$STAGE/release" --strip-components "$(printf '%s' "$PREFIX" | tr -cd / | wc -c | tr -d ' ')"
[ -f "$STAGE/release/src/main.ts" ] || { echo "The snapshot has no src/main.ts." >&2; exit 1; }
mv "$STAGE/release/launch.mjs" "$STAGE/launch.mjs"

echo "Shipping $ID ($BRANCH) to $HOST as \"$NAME\"..."

# The other side reads its settings from the environment, so nothing here is
# pasted into the script it runs.
REMOTE_ENV=$(printf 'ID=%q COMMIT=%q BRANCH=%q NAME=%q SYNC_URL=%q REMOTE_NODE=%q' \
  "$ID" "$COMMIT" "$BRANCH" "$NAME" "$SYNC_URL" "$REMOTE_NODE")

read -r -d '' REMOTE <<'EOS' || true
set -euo pipefail
NODE="${REMOTE_NODE:-$(bash -lc 'command -v node' 2>/dev/null || true)}"
[ -x "$NODE" ] || { echo "No node on $(hostname); pass --node." >&2; exit 1; }
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 24 ] || { echo "$NODE is Node $MAJOR; the runner needs 24 or newer." >&2; exit 1; }
LOGIN_PATH="$(bash -lc 'printf %s "$PATH"' </dev/null 2>/dev/null || true)"
AGENT_PATH="$(dirname "$NODE"):$HOME/.local/bin:${LOGIN_PATH:-/usr/local/bin:/usr/bin:/bin}"

H="$HOME/Library/Application Support/Threadbear"
R="$H/runner"
UNIT="com.mikerosoft.threadbear.runner.service"
UNITS="$HOME/.config/systemd/user"
LOG="$HOME/Library/Logs/threadbear-runner.log"
mkdir -p "$R/releases" "$H/secrets" "$UNITS" "$(dirname "$LOG")" "$HOME/ThreadbearThreads"
chmod 700 "$H/secrets"

IN="$R/.incoming-$ID"
rm -rf "$IN"; mkdir -p "$IN"
tar -xz -C "$IN"
BUILD="$R/releases/.building-$ID"
rm -rf "$BUILD"
mv "$IN/release" "$BUILD"
echo "Installing packages there (npm ci --omit=dev)..."
(cd "$BUILD" && PATH="$(dirname "$NODE"):$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
# No checkout: the release can't follow main by itself, and says so.
"$NODE" -e '
  const [file, id, commit, branch] = process.argv.slice(1);
  require("fs").writeFileSync(file, JSON.stringify({ id, commit, branch, dirty: false, builtAt: new Date().toISOString(), node: process.versions.node, shipped: "deploy-remote.sh" }, null, 2) + "\n");
' "$BUILD/release.json" "$ID" "$COMMIT" "$BRANCH"
mv "$BUILD" "$R/releases/$ID"

cp "$IN/launch.mjs" "$R/.launch-new.mjs"
mv -f "$R/.launch-new.mjs" "$R/launch.mjs"
rm -rf "$IN"
TB_DIR="$R" TB_ID="$ID" "$NODE" --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  const m = await import(pathToFileURL(process.env.TB_DIR + "/launch.mjs").href);
  m.pointCurrent(process.env.TB_DIR, process.env.TB_ID);
  m.writeState(process.env.TB_DIR, { ...m.readState(process.env.TB_DIR), current: process.env.TB_ID });'

if [ ! -f "$H/runner.json" ]; then
  "$NODE" -e '
    const [file, url, name] = process.argv.slice(1);
    const json = { port: 8797, followMain: false, codexPath: "~/.local/bin/codex", cliUpdates: { checkMinutes: 10080 }, sync: { url, name }, defaults: { cwd: "~/ThreadbearThreads" } };
    require("fs").writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  ' "$H/runner.json" "$SYNC_URL" "$NAME"
  echo "Wrote $H/runner.json."
fi

q() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"; }
cat > "$UNITS/$UNIT.tmp" <<EOF
# Threadbear runner, written by runner/scripts/deploy-remote.sh on the Mac.
[Unit]
Description=Threadbear runner (shipped from the Mac)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(q "$NODE") $(q "$R/launch.mjs")
WorkingDirectory=${R//%/%%}
Environment=$(q "PATH=$AGENT_PATH")
Environment="LANG=C.UTF-8"
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
StandardOutput=append:${LOG//%/%%}
StandardError=append:${LOG//%/%%}

[Install]
WantedBy=default.target
EOF
mv "$UNITS/$UNIT.tmp" "$UNITS/$UNIT"

# Keep the newest three releases and the one just shipped.
ls -1 "$R/releases" | grep -v '^\.' | sort | head -n -3 | while read -r old; do
  [ "$old" = "$ID" ] || rm -rf "$R/releases/$old"
done

if [ ! -s "$H/secrets/convex-key" ]; then
  echo "No backend key there yet. On this Mac run: tb runner add $NAME --ssh <host>, then run this again."
  systemctl --user daemon-reload
  exit 0
fi
MARK=0
[ ! -f "$LOG" ] || MARK="$(wc -l < "$LOG")"
systemctl --user daemon-reload
systemctl --user enable --quiet "$UNIT"
systemctl --user restart "$UNIT"
echo "Started $ID; waiting for it to be marked good (about a minute)..."
for _ in $(seq 1 60); do
  sleep 2
  NEW="$(tail -n +"$((MARK + 1))" "$LOG" 2>/dev/null || true)"
  if printf '%s' "$NEW" | grep -q "marked this release good"; then echo "$ID is up and marked good."; exit 0; fi
  if ! systemctl --user is-active --quiet "$UNIT"; then break; fi
done
echo "It didn't get marked good. The end of $LOG:" >&2
tail -n 20 "$LOG" >&2
exit 1
EOS

# macOS tar would otherwise carry extended attributes, which GNU tar warns about.
COPYFILE_DISABLE=1 tar --no-xattrs -cz -C "$STAGE" release launch.mjs | ssh "$HOST" "$REMOTE_ENV bash -c $(printf '%q' "$REMOTE")"
