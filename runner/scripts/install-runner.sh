#!/bin/bash
# Installs the Threadbear runner as a launchd LaunchAgent
# (com.mikerosoft.threadbear.runner) that starts at login and is restarted
# if it ever exits. On Linux it's a systemd user service of the same name
# instead (~/.config/systemd/user/<label>.service), with no Runner.app:
# everything below about the plist goes for the unit file there.
#
#   scripts/install-runner.sh              install (or reinstall) and start it
#   scripts/install-runner.sh --print      print the plist and change nothing
#   scripts/install-runner.sh --uninstall  stop it and remove the plist
#
# The runner runs from a release, never from this checkout: the plist
# starts <home>/runner/launch.mjs, which starts the release
# <home>/runner/current points at. The first release is built here; after
# that, ship changes with scripts/deploy-runner.sh.
#
# The plist's program is a small app, ~/Applications/Threadbear Runner.app
# (launcher/main.swift says why: macOS names the LaunchAgent's program in
# its privacy prompts, so this way they say "Threadbear Runner", not
# "node"), which runs `node launch.mjs` as its child. It is built here when
# it's missing or launcher/ changed, and otherwise left alone, so its
# signature, and the privacy grants tied to it, survive runner releases and
# Node updates. A sandbox install builds its own in <home>/runner/.
#
# It replaces a running copy only when no thread is busy (a turn, or
# background shells and subagents), since that stops them; --force does it
# anyway. It keeps the release current names only if it was built from
# HEAD, and otherwise builds one that was. If the new runner doesn't come up
# and stay up until it is marked good (about a minute), the old plist,
# launch.mjs and current are put back; a first install that fails is
# removed again (the releases stay), so launchd isn't left starting a
# program that isn't there.
#
# Options:
#   --from-source  run src/main.ts straight from this checkout instead, as
#                  before releases (for debugging the runner itself)
#   --force        replace the running copy even if threads are busy
#   --allow-branch install from a HEAD that isn't main's tip (its launch.mjs
#                  and release)
#   --home DIR     data dir (default ~/Library/Application Support/Threadbear)
#   --label LABEL  launchd label (default com.mikerosoft.threadbear.runner)
#   --port N       port to listen on (default: the one in runner.json, else
#                  8797). A sandbox next to the real runner needs its own
#                  --home and --label; its port defaults to 0, a free one.
#   --node PATH    Node 24 binary to pin in the plist
#                  (default: $THREADBEAR_NODE, else ~/.nvm/versions/node/v24.22.1/bin/node)
#   --runner-app DIR  where Threadbear Runner.app goes (default:
#                  $THREADBEAR_RUNNER_APP_DIR, else ~/Applications/Threadbear
#                  Runner.app, or <home>/runner/Threadbear Runner.app for a
#                  sandbox)
#   --path PATH    PATH for the runner and the agents it starts
#                  (default: your login shell's PATH, captured now)
#
# THREADBEAR_LAUNCHCTL and THREADBEAR_LAUNCH_AGENTS_DIR replace launchctl
# and ~/Library/LaunchAgents (the tests use both); on Linux,
# THREADBEAR_SYSTEMCTL and THREADBEAR_SYSTEMD_UNITS_DIR replace systemctl
# and ~/.config/systemd/user.
set -euo pipefail

# THREADBARE_* was the old name for these variables: each stands in for its new name.
for v in $(compgen -e | grep '^THREADBARE_' || true); do n="THREADBEAR_${v#THREADBARE_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
DEFAULT_LABEL="com.mikerosoft.threadbear.runner"
DEFAULT_HOME="$HOME/Library/Application Support/Threadbear"
RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${THREADBEAR_NODE:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
LAUNCHCTL="${THREADBEAR_LAUNCHCTL:-launchctl}"
AGENTS_DIR="${THREADBEAR_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
# A runner on Linux (INSTALL.md, "A runner on Linux"): systemd keeps it up.
LINUX=0
[ "$(uname -s)" = Linux ] && LINUX=1
SYSTEMCTL="${THREADBEAR_SYSTEMCTL:-systemctl}"
if [ "$LINUX" = 1 ]; then AGENTS_DIR="${THREADBEAR_SYSTEMD_UNITS_DIR:-$HOME/.config/systemd/user}"; fi
LABEL="$DEFAULT_LABEL"
DATA_HOME="$DEFAULT_HOME"
PORT=""
AGENT_PATH=""
RUNNER_APP="${THREADBEAR_RUNNER_APP_DIR:-}"
FROM_SOURCE=0
FORCE=0
ALLOW_BRANCH=0
HOME_GIVEN=0
MODE="install"
ARGS=("$@")

while [ $# -gt 0 ]; do
  case "$1" in
    --print) MODE="print" ;;
    --uninstall) MODE="uninstall" ;;
    --from-source) FROM_SOURCE=1 ;;
    --force) FORCE=1 ;;
    --allow-branch) ALLOW_BRANCH=1 ;;
    --home) DATA_HOME="${2:?--home needs a folder}"; HOME_GIVEN=1; shift ;;
    --label) LABEL="${2:?--label needs a launchd label}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --node) NODE="${2:?--node needs the path to a Node binary}"; shift ;;
    --runner-app) RUNNER_APP="${2:?--runner-app needs a folder}"; shift ;;
    --path) AGENT_PATH="${2:?--path needs a PATH}"; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

case "$DATA_HOME" in /*) ;; *) DATA_HOME="$PWD/$DATA_HOME" ;; esac
DATA_HOME="${DATA_HOME%/}"

# Same folder, even through a symlink (/tmp is /private/tmp).
same_dir() {
  [ "$1" = "$2" ] && return 0
  [ -d "$1" ] && [ -d "$2" ] && [ "$(cd "$1" && pwd -P)" = "$(cd "$2" && pwd -P)" ]
}

SANDBOX=0
same_dir "$DATA_HOME" "$DEFAULT_HOME" || SANDBOX=1
# A sandbox under the real label would replace the real runner, and a
# second label on the real data dir would be a second runner fighting
# for its lock.
if [ "$SANDBOX" = 1 ] && [ "$LABEL" = "$DEFAULT_LABEL" ]; then
  echo "A runner on another data dir needs its own --label (say $DEFAULT_LABEL.devtest), or it would replace the real one." >&2
  exit 1
fi
if [ "$SANDBOX" = 0 ] && [ "$LABEL" != "$DEFAULT_LABEL" ]; then
  echo "$DATA_HOME belongs to $DEFAULT_LABEL; give a second runner its own --home." >&2
  exit 1
fi
if [ "$SANDBOX" = 1 ]; then
  [ -n "$PORT" ] || PORT=0
  LOG="$DATA_HOME/runner.log"
  [ -n "$RUNNER_APP" ] || RUNNER_APP="$DATA_HOME/runner/Threadbear Runner.app"
else
  LOG="$HOME/Library/Logs/threadbear-runner.log"
  [ -n "$RUNNER_APP" ] || RUNNER_APP="$HOME/Applications/Threadbear Runner.app"
fi
case "$RUNNER_APP" in /*) ;; *) RUNNER_APP="$PWD/$RUNNER_APP" ;; esac
RUNNER_APP="${RUNNER_APP%/}"
# The plist's program: the app's executable, given node and the program
# to run as its arguments (it spawns them, so launchd's job, the process
# macOS asks about, is the app).
LAUNCHER="$RUNNER_APP/Contents/MacOS/Threadbear Runner"
BUILD_LAUNCHER="$RUNNER_DIR/launcher/build-launcher.sh"
PLIST="$AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"
UNIT="$LABEL.service"
[ "$LINUX" = 0 ] || PLIST="$AGENTS_DIR/$UNIT"

# Whether the job is loaded (launchd) or running (systemd): a copy that
# replacing would stop.
svc_loaded() {
  if [ "$LINUX" = 1 ]; then "$SYSTEMCTL" --user is-active --quiet "$UNIT" 2>/dev/null; else "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; fi
}
# Stops the job and stops it starting again.
svc_remove() {
  if [ "$LINUX" = 1 ]; then "$SYSTEMCTL" --user disable --now "$UNIT" 2>/dev/null || true; else "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true; fi
}

# The pid in <home>/run/runner.pid (plain, or JSON with the pid first).
runner_pid() {
  [ -f "$1/run/runner.pid" ] || return 1
  grep -o '[0-9][0-9]*' "$1/run/runner.pid" 2>/dev/null | head -n 1
}

# True if pid $1 is an ancestor of this script: a CLI that runner started
# ran it, directly or through a shell or a dev runner.
is_ancestor() {
  local p="$PPID" n=0
  while [ -n "$p" ] && [ "$p" -gt 1 ] && [ "$n" -lt 200 ]; do
    [ "$p" = "$1" ] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    n=$((n + 1))
  done
  return 1
}

# Reinstalling or removing the runner a thread runs on ends that thread's
# turn, so an agent hands it to Mike instead. That's decided by the process
# tree (which works under any runner, and whatever an agent exported) and
# by THREADBEAR_RUNNER_HOME, which the runner sets and nothing tells an
# agent to change. THREADBEAR_HOME is the one agents point at dev runners,
# so it can't be trusted for this. The real runner is refused from any
# thread at all.
if [ "$MODE" != "print" ]; then
  IN_THREAD=0
  PID="$(runner_pid "$DATA_HOME" || true)"
  if [ -n "$PID" ] && is_ancestor "$PID"; then IN_THREAD=1; fi
  if [ -n "${THREADBEAR_THREAD_ID:-}" ]; then
    if [ "$SANDBOX" = 0 ] || same_dir "${THREADBEAR_RUNNER_HOME:-${THREADBEAR_HOME:-${THREADBEAR_DATA_DIR:-$DEFAULT_HOME}}}" "$DATA_HOME"; then IN_THREAD=1; fi
  fi
  if [ "$IN_THREAD" = 1 ]; then
    echo "This would stop the runner this thread runs on and end this turn. Ask the user to run it from a terminal:" >&2
    printf '  %q' "$RUNNER_DIR/scripts/install-runner.sh" ${ARGS[@]+"${ARGS[@]}"} >&2
    echo >&2
    exit 1
  fi
fi
# deploy-runner.sh takes its data dir from THREADBEAR_HOME; this script
# doesn't, so someone counting on it would reinstall the real runner.
if [ "$HOME_GIVEN" = 0 ] && [ -n "${THREADBEAR_HOME:-}" ] && ! same_dir "$THREADBEAR_HOME" "$DEFAULT_HOME"; then
  echo "THREADBEAR_HOME is $THREADBEAR_HOME, but install-runner.sh only goes by --home (default $DEFAULT_HOME). Pass --home." >&2
  exit 1
fi

# Loads a launch.mjs the way the LaunchAgent would, short of starting a
# runner (it only starts one when it is the program, not when imported), and
# checks it has what deploy-runner.sh imports from it.
check_launch() {
  "$NODE" --check "$1" && TB_LAUNCH="$1" "$NODE" --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const m = await import(pathToFileURL(process.env.TB_LAUNCH).href);
    for (const f of ["planBoot", "readState", "writeState", "pointCurrent", "readCurrentLink", "releaseExists", "markBootClean"]) {
      if (typeof m[f] !== "function") throw new Error(`launch.mjs has no ${f}()`);
    }'
}

# deploy-runner.sh (which the busy check below runs) imports this
# checkout's launch.mjs, so a broken one would look like busy threads.
LAUNCH_OK=1
if [ "$MODE" != "print" ] && [ -x "$NODE" ] && ! check_launch "$RUNNER_DIR/launch.mjs"; then
  LAUNCH_OK=0
fi

if [ "$MODE" = "uninstall" ]; then
  if [ "$FORCE" = 0 ] && [ "$LAUNCH_OK" = 0 ]; then
    echo "$RUNNER_DIR/launch.mjs doesn't load (above), so this can't check whether threads are busy. Fix it, or add --force." >&2
    exit 1
  fi
  if [ "$FORCE" = 0 ] && svc_loaded && [ -x "$NODE" ] \
    && ! THREADBEAR_NODE="$NODE" bash "$RUNNER_DIR/scripts/deploy-runner.sh" --home "$DATA_HOME" --label "$LABEL" --check-idle; then
    echo "Not removing $LABEL while threads are busy: they'd be cut short. Run it again once they finish, or add --force." >&2
    exit 1
  fi
  svc_remove
  rm -f "$PLIST"
  [ "$LINUX" = 0 ] || "$SYSTEMCTL" --user daemon-reload 2>/dev/null || true
  echo "Removed $LABEL. The data in $DATA_HOME (releases included) is untouched."
  # The app stays too: the privacy grants macOS gave it belong to it, and a
  # reinstall picks it up as it is.
  [ "$LINUX" = 1 ] || [ ! -d "$RUNNER_APP" ] || echo "$RUNNER_APP stays; delete it yourself if you're done with Threadbear."
  exit 0
fi

if [ ! -x "$NODE" ]; then
  echo "No Node binary at $NODE. Pass --node /path/to/node (Node 24 or newer)." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "$NODE is Node $NODE_MAJOR; the runner needs Node 24 or newer (it runs TypeScript directly)." >&2
  exit 1
fi

if [ -z "$AGENT_PATH" ]; then
  # launchd starts jobs with a bare PATH. Agents run shell commands, so give
  # them the PATH a terminal would have. Markers skip anything the shell's
  # startup files print.
  AGENT_PATH="$("${SHELL:-/bin/zsh}" -ilc 'printf "__TBPATH__%s__TBPATH__" "$PATH"' </dev/null 2>/dev/null \
    | sed -n 's/.*__TBPATH__\(.*\)__TBPATH__.*/\1/p' || true)"
  [ -n "$AGENT_PATH" ] || AGENT_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
fi
# The pinned Node and the claude CLI (~/.local/bin) always come first.
AGENT_PATH="$(dirname "$NODE"):$HOME/.local/bin:$AGENT_PATH"

if [ "$FROM_SOURCE" = 1 ]; then
  PROGRAM="$RUNNER_DIR/src/main.ts"
  WORKDIR="$RUNNER_DIR"
else
  PROGRAM="$DATA_HOME/runner/launch.mjs"
  WORKDIR="$DATA_HOME/runner"
fi

# sed rather than ${s//</&lt;}: bash 5.2 reads & in a replacement as the
# match, so that would differ between /bin/bash and Homebrew's.
xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

env_entry() {
  printf '\t\t<key>%s</key>\n\t\t<string>%s</string>\n' "$1" "$(xml "$2")"
}

plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$(xml "$LABEL")</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml "$LAUNCHER")</string>
		<string>$(xml "$NODE")</string>
		<string>$(xml "$PROGRAM")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml "$WORKDIR")</string>
	<key>EnvironmentVariables</key>
	<dict>
$(env_entry PATH "$AGENT_PATH")
$(env_entry LANG en_US.UTF-8)
$(env_entry THREADBEAR_RUNNER_APP "$RUNNER_APP")
EOF
  if [ "$SANDBOX" = 1 ]; then
    env_entry THREADBEAR_HOME "$DATA_HOME"
    env_entry THREADBEAR_LOG "$LOG"
  fi
  [ -z "$PORT" ] || env_entry THREADBEAR_PORT "$PORT"
  cat <<EOF
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>ExitTimeOut</key>
	<integer>30</integer>
	<key>StandardOutPath</key>
	<string>$(xml "$LOG")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
}

# The systemd unit, for Linux: the same job as the plist. systemd starts
# node itself (no launcher app), restarts it whatever way it exits (like
# KeepAlive; launch.mjs exits 0 for a planned restart), and gives it 30
# seconds after SIGTERM, like ExitTimeOut. KillMode=mixed sends SIGTERM to
# launch.mjs alone, so it stops the runner and its CLIs in order, and
# SIGKILL to anything left after that.
unit_quote() {
  # systemd's own quoting: double quotes, with \ and " escaped, and % as %%.
  # (WorkingDirectory and StandardOutput take a bare path instead, spaces
  # and all; only the % needs doubling there.)
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
}
unit() {
  cat <<EOF
# Threadbear runner, written by runner/scripts/install-runner.sh. Reinstall
# rather than edit: the next install writes it again.
[Unit]
Description=Threadbear runner ($LABEL)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(unit_quote "$NODE") $(unit_quote "$PROGRAM")
WorkingDirectory=$(printf '%s' "$WORKDIR" | sed -e 's/%/%%/g')
Environment=$(unit_quote "PATH=$AGENT_PATH")
Environment="LANG=C.UTF-8"
EOF
  if [ "$SANDBOX" = 1 ]; then
    echo "Environment=$(unit_quote "THREADBEAR_HOME=$DATA_HOME")"
    echo "Environment=$(unit_quote "THREADBEAR_LOG=$LOG")"
  fi
  [ -z "$PORT" ] || echo "Environment=$(unit_quote "THREADBEAR_PORT=$PORT")"
  cat <<EOF
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
StandardOutput=append:${LOG//%/%%}
StandardError=append:${LOG//%/%%}

[Install]
WantedBy=default.target
EOF
}

# The job's file: the plist, or the unit on Linux.
job_file() {
  if [ "$LINUX" = 1 ]; then unit; else plist; fi
}

if [ "$MODE" = "print" ]; then
  job_file
  exit 0
fi

# deploy-runner.sh, on the Node the plist pins.
deploy() {
  THREADBEAR_NODE="$NODE" bash "$RUNNER_DIR/scripts/deploy-runner.sh" --home "$DATA_HOME" --label "$LABEL" "$@"
}

# Loads $PLIST and starts it. Straight after a bootout, bootstrap can fail
# for a moment while launchd is still tearing the old job down ("Bootstrap
# failed: 5: Input/output error"), so it gets a few tries.
load() {
  local out="" i
  if [ "$LINUX" = 1 ]; then
    "$SYSTEMCTL" --user daemon-reload && "$SYSTEMCTL" --user enable --quiet "$UNIT" && "$SYSTEMCTL" --user restart "$UNIT" && return 0
    echo "systemctl --user couldn't start $UNIT: systemctl --user status $UNIT says why." >&2
    return 1
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if out="$("$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" 2>&1)"; then
      "$LAUNCHCTL" kickstart "$DOMAIN/$LABEL" 2>/dev/null || true
      return 0
    fi
    sleep 0.5
  done
  echo "launchctl bootstrap $DOMAIN $PLIST failed: $out" >&2
  return 1
}

# Stops the job and starts it again from the plist.
reload() {
  # systemd's restart stops the old one first and waits for it.
  if [ "$LINUX" = 1 ]; then load; return; fi
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout returns before the old job is gone; bootstrap fails until it is.
  for _ in $(seq 1 100); do
    "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.25
  done
  load
}

# The commit a release was built from, or nothing for a dirty build.
release_commit() {
  "$NODE" -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(r.dirty ? "" : String(r.commit || "")); } catch {}' "$1"
}

# Points current back at a release, with the same helpers deploy-runner.sh
# uses (from this checkout's launch.mjs, already checked above).
point_current() {
  TB_LAUNCH="$RUNNER_DIR/launch.mjs" TB_DIR="$RDIR" TB_ID="$1" "$NODE" --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const m = await import(pathToFileURL(process.env.TB_LAUNCH).href);
    const { TB_DIR: dir, TB_ID: id } = process.env;
    m.pointCurrent(dir, id);
    m.writeState(dir, { ...m.readState(dir), current: id });'
}

RDIR="$DATA_HOME/runner"
LOADED=0
svc_loaded && LOADED=1

# Everything that can be refused is refused before anything changes.
# launch.mjs first: it is the LaunchAgent's program, nothing tests it once
# it's in, and deploy-runner.sh can't run without it.
if [ "$FROM_SOURCE" = 0 ] && [ "$LAUNCH_OK" = 0 ]; then
  echo "$RUNNER_DIR/launch.mjs doesn't load, so nothing was changed." >&2
  exit 1
fi
if [ "$FROM_SOURCE" = 0 ] && [ "$ALLOW_BRANCH" = 0 ] && ! deploy --check-branch; then
  echo "The LaunchAgent should run main. Install from main's tip, or pass --allow-branch." >&2
  exit 1
fi
# Replacing a running copy stops its CLIs, and every turn and background
# job with them, so only when nothing is busy.
if [ "$LOADED" = 1 ] && [ "$FORCE" = 0 ]; then
  if [ "$LAUNCH_OK" = 0 ]; then
    echo "$RUNNER_DIR/launch.mjs doesn't load (above), so this can't check whether threads are busy. Fix it, or add --force." >&2
    exit 1
  fi
  if ! deploy --check-idle; then
    echo "Not replacing the running $LABEL while threads are busy: they'd be cut short. Run this again once they finish, or add --force." >&2
    exit 1
  fi
fi

# What this run replaces, kept to put back if the new runner doesn't come
# up. In the data dir, not LaunchAgents: launchd reads every file there.
PREV="$RDIR/previous-launchagent.plist"
PREV_LAUNCH="$RDIR/previous-launch.mjs"
NEW_LAUNCH=""
HAD_LAUNCH=0
SWAPPED=0
OLD_CURRENT=""
BUILT=0
TMP=""
mkdir -p "$AGENTS_DIR" "$(dirname "$LOG")" "$RDIR"
rm -f "$PREV" "$PREV_LAUNCH"

# The app the plist runs, built only when it's missing or launcher/
# changed since (its signature is what privacy grants are tied to, so the
# fewer rebuilds the better; a rebuild signs it the same way regardless).
# build-launcher.sh leaves the old app next to the new one as
# .Threadbear Runner.app.old, so a failed install can put it back.
OLD_APP="$(dirname "$RUNNER_APP")/.$(basename "$RUNNER_APP").old"
APP_BUILT=0
[ "$LINUX" = 1 ] || rm -rf "$OLD_APP"
if [ "$LINUX" = 1 ]; then
  # No app on Linux: nothing there asks for privacy grants.
  :
elif why="$(bash "$BUILD_LAUNCHER" --check "$RUNNER_APP")"; then
  echo "Keeping $RUNNER_APP, built from launcher/ as it is."
else
  echo "$why"
  if ! bash "$BUILD_LAUNCHER" "$RUNNER_APP"; then
    echo "Threadbear Runner.app didn't build, so nothing was changed." >&2
    exit 1
  fi
  APP_BUILT=1
fi

if [ "$FROM_SOURCE" = 1 ]; then
  if [ ! -d "$RUNNER_DIR/node_modules/@anthropic-ai/claude-agent-sdk" ] || [ ! -d "$RUNNER_DIR/node_modules/ws" ]; then
    echo "Installing the runner's packages..."
    (cd "$RUNNER_DIR" && PATH="$(dirname "$NODE"):$PATH" npm ci)
  fi
else
  # The copy that goes in, checked again in case the checkout changed
  # since the check above.
  NEW_LAUNCH="$RDIR/.launch-new.mjs"
  cp "$RUNNER_DIR/launch.mjs" "$NEW_LAUNCH"
  if ! check_launch "$NEW_LAUNCH"; then
    rm -f "$NEW_LAUNCH"
    echo "$RUNNER_DIR/launch.mjs doesn't load, so nothing was changed." >&2
    exit 1
  fi
  # A release built from anything but HEAD would quietly take merged work
  # back out (or ship what a feature branch had), so current is only kept
  # when it was built from HEAD.
  [ ! -L "$RDIR/current" ] || OLD_CURRENT="$(basename "$(readlink "$RDIR/current")")"
  HEAD_COMMIT="$(git -C "$RUNNER_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$OLD_CURRENT" ] && [ -n "$HEAD_COMMIT" ] && [ "$(release_commit "$RDIR/current/release.json")" = "$HEAD_COMMIT" ]; then
    echo "Keeping release $OLD_CURRENT, which was built from HEAD."
  else
    [ -z "$OLD_CURRENT" ] || echo "Release $OLD_CURRENT wasn't built from HEAD, so building one that is."
    BRANCH_ARG=()
    [ "$ALLOW_BRANCH" = 0 ] || BRANCH_ARG=(--allow-branch)
    if ! deploy --no-restart ${BRANCH_ARG[@]+"${BRANCH_ARG[@]}"}; then
      rm -f "$NEW_LAUNCH"
      exit 1
    fi
    BUILT=1
  fi
fi

# Puts back what this run replaced (the plist, launch.mjs and current) and
# starts the old setup again. Every failure from here on ends up here,
# through the EXIT trap below if nothing calls it first.
fail_back() {
  trap - EXIT
  set +e
  echo "$1" >&2
  [ -z "$TMP" ] || rm -f "$TMP"
  if [ "$APP_BUILT" = 1 ] && [ -d "$OLD_APP" ]; then
    rm -rf "$RUNNER_APP"
    mv "$OLD_APP" "$RUNNER_APP"
    echo "$RUNNER_APP is the one from before again." >&2
  fi
  if [ -f "$PREV" ]; then
    echo "Putting back the LaunchAgent as it was." >&2
    mv -f "$PREV" "$PLIST"
    if [ "$SWAPPED" = 1 ]; then
      if [ "$HAD_LAUNCH" = 1 ]; then mv -f "$PREV_LAUNCH" "$RDIR/launch.mjs"; else rm -f "$RDIR/launch.mjs"; fi
    fi
    if [ "$BUILT" = 1 ] && [ -n "$OLD_CURRENT" ]; then
      point_current "$OLD_CURRENT" && echo "current points at $OLD_CURRENT again." >&2
    fi
    if reload; then
      echo "Back as it was. The log above says what went wrong; fix it and run this again." >&2
    else
      if [ "$LINUX" = 1 ]; then
        echo "The old unit didn't start either: systemctl --user status $UNIT says why." >&2
      else
        echo "The old plist didn't load either. Load it by hand: launchctl bootstrap $DOMAIN $(printf '%q' "$PLIST")" >&2
      fi
    fi
  else
    # Nothing to go back to, so what this run put in comes out again: a
    # loaded plist whose program is gone (or won't start) would otherwise
    # be started by launchd every few seconds for good, and launch.mjs in
    # the data dir would make deploy-runner.sh think a release could start.
    svc_remove
    rm -f "$PLIST"
    [ "$LINUX" = 0 ] || "$SYSTEMCTL" --user daemon-reload 2>/dev/null || true
    if [ "$SWAPPED" = 1 ]; then
      if [ "$HAD_LAUNCH" = 1 ]; then mv -f "$PREV_LAUNCH" "$RDIR/launch.mjs"; else rm -f "$RDIR/launch.mjs"; fi
    fi
    echo "There was no LaunchAgent before to go back to, so $LABEL is removed again; the releases in $RDIR stay. The log above says what went wrong. To run the runner from this checkout instead:" >&2
    printf '  %q' "$RUNNER_DIR/scripts/install-runner.sh" --from-source ${ARGS[@]+"${ARGS[@]}"} >&2
    echo >&2
  fi
  [ -z "$NEW_LAUNCH" ] || rm -f "$NEW_LAUNCH"
  exit 1
}

[ ! -f "$PLIST" ] || cp "$PLIST" "$PREV"
# An EXIT trap rather than ERR: it also covers set -e exits inside
# functions and Ctrl-C, and never runs in a $(...) subshell.
trap 'fail_back "Replacing the LaunchAgent stopped part way."' EXIT

if [ "$FROM_SOURCE" = 0 ]; then
  if [ -f "$RDIR/launch.mjs" ]; then
    cp -p "$RDIR/launch.mjs" "$PREV_LAUNCH"
    HAD_LAUNCH=1
  fi
  # Only now that there's a release for it to start: deploy-runner.sh takes
  # launch.mjs being here to mean the LaunchAgent runs releases.
  mv -f "$NEW_LAUNCH" "$RDIR/launch.mjs"
  SWAPPED=1
fi
TMP="$(mktemp "$PLIST.XXXXXX")"
job_file > "$TMP"
[ "$LINUX" = 1 ] || plutil -lint "$TMP" >/dev/null
mv "$TMP" "$PLIST"
TMP=""

# The runner stops its CLIs on SIGTERM; threads that were mid-turn show as
# stopped and resume on the next message.
reload || fail_back "launchd wouldn't load the new plist."

echo "Installed $LABEL"
[ "$LINUX" = 1 ] || echo "  app:    $RUNNER_APP"
echo "  node:   $NODE"
echo "  runner: $PROGRAM"
echo "  data:   $DATA_HOME"
echo "  log:    $LOG"
if [ "$FROM_SOURCE" = 1 ]; then
  # So nothing takes this data dir to run releases (deploy-runner.sh
  # refuses to ship to it); installing without --from-source copies it in
  # again.
  [ ! -f "$RDIR/launch.mjs" ] || mv "$RDIR/launch.mjs" "$RDIR/launch.mjs.unused"
else
  deploy --check || fail_back "The runner didn't come up and stay up on its release."
  if [ "$SANDBOX" = 1 ]; then
    echo "Ship changes with: scripts/deploy-runner.sh --home $(printf '%q' "$DATA_HOME") --label $LABEL"
  else
    echo "Ship changes with: scripts/deploy-runner.sh"
  fi
fi
trap - EXIT
rm -f "$PREV" "$PREV_LAUNCH"
[ "$LINUX" = 1 ] || rm -rf "$OLD_APP"
if [ "$LINUX" = 1 ]; then
  echo "Restart it with: systemctl --user restart $UNIT"
  # A user service stops when its user's last session ends unless lingering
  # is on, and a server nobody logs into has no session at all.
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    echo
    echo "So it keeps running with nobody logged in, turn on lingering once:"
    echo "  sudo loginctl enable-linger $(id -un)"
  fi
  exit 0
fi
echo "Restart it with: launchctl kickstart -k $DOMAIN/$LABEL"
# Only a person can grant this, and a Mac nobody sits at needs it: a prompt left
# waiting there can hold up other apps using the same drive
# (docs/setup-and-updates.md, "A Mac nobody sits at"). Whether the runner has it
# can't be asked from here, as this shell isn't the runner; tb status says.
echo
echo "If nobody sits at this Mac, give Threadbear Runner Full Disk Access:"
echo "  System Settings > Privacy & Security > Full Disk Access, then add $RUNNER_APP"
if [ "$SANDBOX" = 0 ] && [ ! -d "/Applications/Threadbear.app" ] && [ ! -d "$HOME/Applications/Threadbear.app" ]; then
  open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles" 2>/dev/null || true
fi
