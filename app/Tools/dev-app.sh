#!/usr/bin/env bash
# Debug builds of the app for an agent to look at and drive: each in a temp
# bundle, against the mock runner or a dev runner, with its window kept
# behind whatever Mike is working in. Several can run at once: each has its
# own id, bundle id (so its own settings), data folder, automation channel
# and pasteboard. Nothing here touches the installed app, the live runner or
# its data folder.
#
#   Tools/dev-app.sh start [--mock [--fixtures DIR]...] [--home DIR]
#                          [--appearance light|dark] [--size WxH] [--bear-date 2026-12-24T23:00] [--id NAME]
#   Tools/dev-app.sh do '<json>'... [--timeout S]
#   Tools/dev-app.sh shot <file.png> [--sheet] [--settings]   (the sheet over it, the Settings window, or with both the sheet over Settings)
#   Tools/dev-app.sh menu <file.png> '{"x":854,"y":19}'   (a real menu, opened and captured; realMenu in app/README.md)
#   Tools/dev-app.sh dump [--json]
#   Tools/dev-app.sh rebuild
#   Tools/dev-app.sh log [-f] [-n N] [--mock | --automation]
#   Tools/dev-app.sh stop [--all | --everyone]
#   Tools/dev-app.sh status
#
# start    builds the debug app, starts the mock runner (its demo threads, or
#          only the --fixtures folders given: `tb export` puts one thread in
#          app/.fixtures/threads/<id>) or points at a dev runner's --home
#          (runner/scripts/dev-runner.sh), launches the app with
#          --automation, waits until it's connected and prints the id.
# do       sends each command and prints its result line ("open ok ...");
#          exits 1 on an error result or a timeout. The commands are in
#          app/README.md, "Seeing and driving it from a script".
# shot     saves the window as a PNG: screencapture -l from this shell, or
#          the app's own drawing when that gives no image (screen locked,
#          or no Screen Recording permission), which it says.
# dump     what the window shows: the sidebar's rows by section, the open
#          thread's rows (id, kind, height, open or closed, text; > marks
#          the ones on screen), the selection, the composer (its text, and
#          the folder, account, model and access a send would use) and the
#          banner.
# rebuild  builds again and restarts the app with the same options, on the
#          same runner (the mock keeps its state), reopening the thread that
#          was open. A build that fails leaves the running app alone.
# log      the app's own log: connection, RPC errors, automation commands.
# stop     quits the app and its mock and deletes the instance's files.
#
# Instances belong to whoever started them: the Threadbear thread
# (THREADBEAR_THREAD_ID) and this checkout. Without --id a command means
# your newest running instance, never another thread's or another
# checkout's; stop --all stops all of yours (--everyone: every instance on
# this Mac). status lists them all, with whose they are. An app quits after
# 60 minutes with no command, and its mock with it; start and status clean
# up after instances whose app has quit.
set -Eeuo pipefail

# THREADBARE_* was the old name for these variables: each stands in for its new name.
for v in $(compgen -e | grep '^THREADBARE_' || true); do n="THREADBEAR_${v#THREADBARE_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$TOOLS_DIR/.." && pwd)"
# The checkout an instance was built from, and the thread that started it.
CHECKOUT="$(cd "$APP_ROOT/.." && pwd -P)"
OWNER_THREAD="${THREADBEAR_THREAD_ID:-}"
TMP_ROOT="${TMPDIR:-/tmp}"
mkdir -p "${TMP_ROOT%/}/threadbear-dev-app"
# With symlinks resolved (/var is /private/var): it's how the app's own
# path reads in ps and pgrep.
STATE_ROOT="$(cd "${TMP_ROOT%/}/threadbear-dev-app" && pwd -P)"
# Build logs outlive a failed start, whose instance folder is deleted.
BUILD_LOGS="$STATE_ROOT/build-logs"
REAL_HOME="$HOME/Library/Application Support/Threadbear"
BUNDLE_PREFIX="com.mikerosoft.threadbear.dev"
CHANNEL_PREFIX="com.mikerosoft.threadbear.automation"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
# An instance nobody sends a command to for this long quits by itself
# (the variable is for testing that).
IDLE_QUIT_SECONDS="${DEV_APP_IDLE_QUIT_SECONDS:-3600}"
# Another thread's instance whose app has quit is cleaned up once it has
# been quiet this long (its log may still be wanted).
REAP_OTHERS_AFTER=1800

# A start that fails part way stops what it had started.
CLEANUP_ID=""
die() {
  echo "dev-app: $*" >&2
  if [ -n "$CLEANUP_ID" ]; then
    local id="$CLEANUP_ID"
    CLEANUP_ID=""
    # Its folder going while the start ran means something else cleaned it
    # up, which used to leave only "tail: ...: No such file or directory".
    [ -f "$(instance_dir "$id")/instance" ] ||
      echo "dev-app: $id's folder was removed while it was starting (another dev-app.sh, or a stop of it); start again" >&2
    stop_one "$id" >/dev/null 2>&1 || true
  fi
  exit 1
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

node_bin() {
  local pinned="${THREADBEAR_NODE:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
  if [ -x "$pinned" ]; then printf '%s' "$pinned"; else command -v node || die "no node binary (set THREADBEAR_NODE)"; fi
}

# The folder with symlinks resolved, or as given if it doesn't exist.
real_dir() {
  if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s' "${1%/}"; fi
}

# A JSON string for a shell string (paths, mostly).
json_string() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# The pid of the app running from this bundle, if any. The bundle's path is
# the instance's own, so this never finds the installed app or another
# instance.
bundle_pid() {
  pgrep -f "^$1/Contents/MacOS/Threadbear( |\$)" | head -n 1 || true
}

mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }

# ------------------------------------------------------------------ instances

instance_dir() { printf '%s/%s' "$STATE_ROOT" "$1"; }

# Reads <instance>/instance (KEY=value lines written by start) into I_*.
load_instance() {
  local dir; dir="$(instance_dir "$1")"
  [ -f "$dir/instance" ] || die "no instance $1 (Tools/dev-app.sh status lists them)"
  I_ID="$1"; I_DIR="$dir"
  I_PID=""; I_MOCK_PID=""; I_DATA=""; I_BUNDLE=""; I_BUNDLE_ID=""; I_RUNNER=""
  I_THREAD=""; I_CHECKOUT=""; I_CREATED=0; I_STARTED=0; I_STARTER=""; I_STARTER_SINCE=""
  while IFS='=' read -r key value; do
    case "$key" in
      pid) I_PID="$value" ;;
      mock_pid) I_MOCK_PID="$value" ;;
      data) I_DATA="$value" ;;
      bundle) I_BUNDLE="$value" ;;
      bundle_id) I_BUNDLE_ID="$value" ;;
      runner) I_RUNNER="$value" ;;
      thread) I_THREAD="$value" ;;
      checkout) I_CHECKOUT="$value" ;;
      created) I_CREATED="$value" ;;
      started) I_STARTED="$value" ;;
      starter) I_STARTER="$value" ;;
      starter_since) I_STARTER_SINCE="$value" ;;
    esac
  done <"$dir/instance"
  I_LOG="$dir/automation.log"
  I_CHANNEL="$CHANNEL_PREFIX.$1"
}

# Sets KEY=value in the loaded instance's file.
set_field() {
  local file="$I_DIR/instance"
  { grep -v "^$1=" "$file" || true; echo "$1=$2"; } >"$file.tmp"
  mv "$file.tmp" "$file"
}

# Started by this thread (or by no thread, outside one) from this checkout.
is_mine() { [ "$I_THREAD" = "$OWNER_THREAD" ] && [ "$I_CHECKOUT" = "$CHECKOUT" ]; }

# The app is running from this instance's own bundle (a pid can be reused).
app_running() {
  alive "$I_PID" && ps -p "$I_PID" -o command= 2>/dev/null | grep -qF "$I_BUNDLE/Contents/MacOS/Threadbear"
}

# This instance's mock runner is still running (it serves the instance's
# own data folder, so a reused pid won't match).
mock_running() {
  alive "$I_MOCK_PID" && ps -p "$I_MOCK_PID" -o command= 2>/dev/null | grep -qF "$I_DIR/data"
}

# Something holds the runner lock in a --home instance's data folder
# (run/runner.pid, {"pid":N,...} or a bare pid from older runners).
home_runner_running() {
  local raw pid
  raw="$(cat "$I_DATA/run/runner.pid" 2>/dev/null)" || return 1
  pid="$(printf '%s' "$raw" | sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p')"
  [ -n "$pid" ] || pid="$(printf '%s' "$raw" | tr -dc '0-9')"
  alive "$pid"
}

# When a process started, as ps tells it: with the pid, it names one
# process, so a pid reused since doesn't pass for the one recorded.
started_at() { ps -p "$1" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//'; }

# The dev-app.sh that's starting or rebuilding this instance is still at it
# (building, usually). start writes its pid and start time with the first
# lines of the instance, rebuild before it stops the old app.
starter_running() {
  alive "$I_STARTER" && [ -n "$I_STARTER_SINCE" ] && [ "$(started_at "$I_STARTER")" = "$I_STARTER_SINCE" ]
}

# "yours", or the thread and checkout that started it.
whose() {
  if is_mine; then printf 'yours'; return; fi
  if [ -n "$I_THREAD" ]; then printf 'thread %s, ' "${I_THREAD:0:8}"; else printf 'no thread, '; fi
  printf 'built from %s' "${I_CHECKOUT:-an unknown checkout}"
}

all_ids() {
  local file
  for file in "$STATE_ROOT"/*/instance; do
    [ -f "$file" ] || continue
    basename "$(dirname "$file")"
  done
}

# Loads the instance a command means: --id, else the caller's newest
# running one. With "any", the caller's newest one even if its app has quit
# (for log and stop).
use_instance() {
  if [ -n "$ID" ]; then
    load_instance "$ID"
    is_mine || echo "dev-app: note: $ID isn't yours ($(whose))." >&2
    return
  fi
  local id best="" best_started=-1 quit="" others=""
  for id in $(all_ids); do
    load_instance "$id"
    if ! is_mine; then others="$others $id"; continue; fi
    if [ "${1:-}" != any ] && ! app_running; then quit="$quit $id"; continue; fi
    if [ "$I_STARTED" -gt "$best_started" ]; then best="$id"; best_started="$I_STARTED"; fi
  done
  if [ -n "$best" ]; then load_instance "$best"; return; fi
  if [ -n "$quit" ]; then
    local first="${quit# }"
    die "your dev app${quit} has quit (after 60 minutes with no command, or it crashed: Tools/dev-app.sh --id ${first%% *} log). Start a new one."
  fi
  [ -z "$others" ] || die "no dev app of yours is running (yours: this thread and checkout). Others' are:${others}; Tools/dev-app.sh status says whose. Start your own, or pass --id."
  die "no dev app is running (Tools/dev-app.sh start)"
}

# The id commands without --id use, or nothing.
default_id() {
  local id best="" best_started=-1
  for id in $(all_ids); do
    load_instance "$id"
    is_mine && app_running || continue
    if [ "$I_STARTED" -gt "$best_started" ]; then best="$id"; best_started="$I_STARTED"; fi
  done
  printf '%s' "$best"
}

# Cleans up instances whose app has quit: the caller's straight away, other
# threads' once they've been quiet for a while (their log may be wanted).
# A start still under way (no pid yet), or a rebuild, is left alone while
# the dev-app.sh doing it is running, however long its build takes: with a load of 150
# one took over 20 minutes, and another thread's start reaped it at 10 and
# its own start died at the end (6 Nov). One whose dev-app.sh has gone
# (killed before it could clean up, or from an older dev-app.sh that didn't
# record itself) is left for 10 minutes.
reap() {
  local id now; now="$(date +%s)"
  find "$BUILD_LOGS" -name '*.log' -mtime +1 -delete 2>/dev/null || true
  for id in $(all_ids); do
    load_instance "$id"
    app_running && continue
    # A start, or a rebuild between quitting the old app and launching the
    # new one (its pid is the old app's then).
    starter_running && continue
    if [ -z "$I_PID" ]; then
      [ $(( now - I_CREATED )) -gt 600 ] || continue
    elif ! is_mine; then
      local quiet; quiet="$(mtime "$I_LOG")"
      [ "$quiet" -gt 0 ] || quiet="$(mtime "$I_DIR/instance")"
      [ $(( now - quiet )) -gt "$REAP_OTHERS_AFTER" ] || continue
    fi
    stop_one "$id" >/dev/null 2>&1 || true
    echo "Cleaned up dev app $id ($(is_mine && echo yours || echo "$(whose)")): its app had quit." >&2
  done
}

# ------------------------------------------------------------------ commands

# Posts one command (a JSON object) to the instance and waits for its
# result line. Prints the line; returns 1 for an error result or a timeout.
send() {
  local command="$1" timeout="${2:-}" rid meta name wait line
  rid="$(date +%s)-$$-$RANDOM"
  # JavaScript for Automation reaches Foundation without compiling
  # anything; it also checks the JSON and tags it with the request id.
  meta="$(/usr/bin/osascript -l JavaScript - "$command" "$I_CHANNEL" "$rid" 2>&1 <<'JXA'
ObjC.import('Foundation');
function run(argv) {
  var command;
  try { command = JSON.parse(argv[0]); } catch (e) { return 'BAD not JSON: ' + argv[0]; }
  if (typeof command !== 'object' || command === null || Array.isArray(command) || typeof command.cmd !== 'string') {
    return 'BAD a command is a JSON object with "cmd": ' + argv[0];
  }
  command.rid = argv[2];
  $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately(
    argv[1], JSON.stringify(command), $(), true);
  return command.cmd + ' ' + (typeof command.timeout === 'number' ? command.timeout : '');
}
JXA
)" || { echo "dev-app: couldn't post $command: $meta" >&2; return 1; }
  case "$meta" in BAD\ *) echo "dev-app: ${meta#BAD }" >&2; return 1 ;; esac
  name="${meta%% *}"
  wait="${meta#* }"
  if [ -z "$timeout" ]; then
    case "$name" in
      # They wait in the app for up to their own timeout (10 s by default).
      waitFor|open) timeout=$(( ${wait%.*} + 10 )); [ -n "$wait" ] || timeout=20 ;;
      *) timeout=30 ;;
    esac
  fi
  local deadline=$(( SECONDS + timeout ))
  while :; do
    line="$(grep -m 1 -F "#$rid " "$I_LOG" 2>/dev/null || true)"
    [ -z "$line" ] || break
    if [ "$name" != quit ] && ! alive "$I_PID"; then
      echo "dev-app: the app quit before answering $name (see Tools/dev-app.sh --id $I_ID log)" >&2
      return 1
    fi
    if [ $SECONDS -ge $deadline ]; then
      echo "$name error no answer in ${timeout}s" >&2
      return 1
    fi
    sleep 0.05
  done
  line="${line#\#$rid }"
  echo "$line"
  case "$line" in "$name error"*) return 1 ;; esac
  return 0
}

# The error lines of a failed build, with a little context: no colour
# codes, and no compiler command lines (several KB each, or a short
# "... failed with a nonzero exit code. Command line: cd ..." that says
# nothing the error lines don't) to wade through.
show_build_errors() {
  sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$1" | awk '
    length($0) > 400 { next }
    /Command line:/ { next }
    /error:/ { keep = 4 }
    keep > 0 { if (!seen[$0]++) { print; shown++ } keep-- }
    shown >= 60 { exit }
    END { if (!shown) exit 1 }
  ' >&2 || sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$1" | awk 'length($0) <= 400' | tail -n 20 >&2
  echo "The whole build log: $1" >&2
}

# Builds the app; on failure prints its errors and returns 1.
build_binary() {
  mkdir -p "$BUILD_LOGS"
  local log="$BUILD_LOGS/$1.log"
  if ! swift build --disable-keychain --package-path "$APP_ROOT" --product Threadbear >"$log" 2>&1; then
    show_build_errors "$log"
    return 1
  fi
  rm -f "$log"
}

# Puts the build into the instance's bundle under its own bundle id.
install_bundle() {
  local bin; bin="$(swift build --package-path "$APP_ROOT" --show-bin-path 2>/dev/null)/Threadbear"
  # Its own bundle id gives it its own settings (window size, sidebar
  # width, last account), so it neither reads nor changes the installed
  # app's, nor another instance's.
  mkdir -p "$I_BUNDLE/Contents/MacOS"
  cp "$bin" "$I_BUNDLE/Contents/MacOS/Threadbear"
  cp "$APP_ROOT/Resources/Info.plist" "$I_BUNDLE/Contents/Info.plist"
  mkdir -p "$I_BUNDLE/Contents/Resources"
  # Packages' resource bundles (Highlightr's), as build-app.sh does.
  local b; for b in "$(dirname "$bin")"/*.bundle; do if [[ -d "$b" ]]; then rm -rf "$I_BUNDLE/Contents/Resources/$(basename "$b")"; cp -R "$b" "$I_BUNDLE/Contents/Resources/"; fi; done
  # LSUIElement keeps it out of the Dock and the app switcher from launch:
  # Cmd-Tabbing into one by mistake and typing into its composer would start
  # a real turn on a dev runner.
  local plist="$I_BUNDLE/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $I_BUNDLE_ID" \
    -c "Set :CFBundleName Threadbear dev $I_ID" -c "Set :CFBundleDisplayName Threadbear dev $I_ID" "$plist"
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$plist"
  codesign --force --sign - "$I_BUNDLE" >/dev/null 2>&1
}

# Launches the bundle with the arguments in app.args and waits until it
# takes commands and is connected. Records its pid (app.pid is what the mock
# watches).
launch_app() {
  local app_args=() arg i pid=""
  while IFS= read -r arg; do app_args+=("$arg"); done <"$I_DIR/app.args"
  # The new app writes "ready" to a fresh log; an old one would pass for it.
  rm -f "$I_LOG"
  # open -g launches it without bringing it forward; the app then puts its
  # window behind everything as soon as it's there (Automation.swift).
  open -g -n "$I_BUNDLE" --stdout "$I_DIR/app.stdout" --stderr "$I_DIR/app.stderr" --args "${app_args[@]}"
  for i in $(seq 1 200); do
    pid="$(bundle_pid "$I_BUNDLE")"
    [ -n "$pid" ] && break
    sleep 0.05
  done
  [ -n "$pid" ] || die "the app didn't start (see $I_DIR/app.stderr)"
  set_field pid "$pid"
  set_field started "$(date +%s)"
  printf '%s' "$pid" >"$I_DIR/app.pid"
  I_PID="$pid"
  for i in $(seq 1 400); do grep -qx ready "$I_LOG" 2>/dev/null && break; sleep 0.05; done
  grep -qx ready "$I_LOG" 2>/dev/null || { cat "$I_LOG" >&2 2>/dev/null || true; die "the app didn't take commands (see $I_DIR/app.stderr)"; }
  send '{"cmd":"waitFor","ready":true,"timeout":20}' >/dev/null || { tail -n 20 "$I_DIR/app.log" >&2; die "the app didn't connect to the runner"; }
}

cmd_start() {
  local mode="" home="" appearance="" size="" bear_date="" fixtures=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --mock) mode=mock ;;
      --fixtures) fixtures+=("$(real_dir "${2:?--fixtures needs a folder}")"); mode=mock; shift ;;
      --home) home="${2:?--home needs a folder}"; shift ;;
      --appearance) appearance="${2:?--appearance needs light or dark}"; shift ;;
      --size) size="${2:?--size needs WxH}"; shift ;;
      --bear-date) bear_date="${2:?--bear-date needs a date, like 2026-12-24T23:00}"; shift ;;
      --id) ID="${2:?--id needs a name}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option for start: $1" ;;
    esac
    shift
  done
  if [ -n "$home" ] && [ "$mode" = mock ]; then die "--home and --mock go to different runners; pick one"; fi
  [ -z "$appearance" ] || [ "$appearance" = light ] || [ "$appearance" = dark ] || die "--appearance is light or dark"
  [ -z "$size" ] || [[ "$size" =~ ^[0-9]+x[0-9]+$ ]] || die "--size is WxH, like 1240x820"
  local fixture live
  live="$(real_dir "$REAL_HOME")"
  for fixture in ${fixtures[@]+"${fixtures[@]}"}; do
    # The live runner's thread folders aren't fixtures: tb export makes one.
    case "$fixture/" in "$live"/*) die "that's inside the live runner's data folder; tb export the thread instead" ;; esac
    [ -f "$fixture/thread.json" ] || ls "$fixture"/*/thread.json >/dev/null 2>&1 || die "no fixtures in $fixture (a tb export folder, or a folder of them)"
  done

  local data runner_model=""
  if [ -n "$home" ]; then
    case "$home" in /*) ;; *) home="$PWD/$home" ;; esac
    # The live runner's data folder holds its token; a debug app driven by
    # an agent never connects to it.
    [ "$(real_dir "$home")" != "$(real_dir "$REAL_HOME")" ] || die "that's the live runner's data folder. Start a dev runner (runner/scripts/dev-runner.sh) and pass its home."
    [ -f "$home/runner.json" ] && [ -f "$home/secrets/runner-token" ] || die "no runner.json and token in $home; is a dev runner running there?"
    data="$(real_dir "$home")"
    runner_model="$(plutil -extract defaults.model raw -o - "$home/runner.json" 2>/dev/null || true)"
  fi

  reap
  if [ -n "$ID" ]; then
    [[ "$ID" =~ ^[A-Za-z0-9_-]{1,24}$ ]] || die "an id is up to 24 letters, digits, - or _"
    if [ -e "$(instance_dir "$ID")/instance" ]; then
      load_instance "$ID"
      is_mine && die "you already have a dev app $ID: stop it first (Tools/dev-app.sh --id $ID stop), or rebuild it"
      die "the id $ID is taken by another thread's dev app ($(whose)); pick another --id"
    fi
  else
    ID="$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  local dir; dir="$(instance_dir "$ID")"
  [ ! -e "$dir" ] || die "there's a leftover folder for $ID at $dir; pick another --id"
  mkdir -p "$dir"
  # Written as it goes, so stop can clean up after a start that failed.
  {
    echo "bundle=$dir/Threadbear.app"
    echo "bundle_id=$BUNDLE_PREFIX.$ID"
    echo "thread=$OWNER_THREAD"
    echo "checkout=$CHECKOUT"
    echo "created=$(date +%s)"
    # So reap leaves it alone while this start is under way.
    echo "starter=$$"
    echo "starter_since=$(started_at $$)"
  } >"$dir/instance.tmp"
  # Whole, or a reap reading it half written finds no created or starter.
  mv "$dir/instance.tmp" "$dir/instance"
  CLEANUP_ID="$ID"
  trap 'die "start failed"' ERR
  load_instance "$ID"

  echo "Building the debug app..."
  build_binary "$ID" || false
  install_bundle

  local runner
  if [ -z "$home" ]; then
    runner=mock
    data="$dir/data"
    mkdir -p "$data"
    local node; node="$(node_bin)"
    if [ ! -d "$TOOLS_DIR/mock-runner/node_modules" ]; then
      (cd "$TOOLS_DIR/mock-runner" && PATH="$(dirname "$node"):$PATH" npm install --silent)
    fi
    # The demo threads unless fixtures were given: the private ones in
    # app/.fixtures are real conversations and stay out of screenshots
    # unless asked for.
    local args=()
    if [ ${#fixtures[@]} -eq 0 ]; then fixtures=("$TOOLS_DIR/mock-runner/fixtures"); fi
    for fixture in "${fixtures[@]}"; do args+=(--fixtures "$fixture"); done
    # It exits once the app has quit (app.pid), so an instance that's
    # never stopped doesn't leave a mock running. It runs in a session of
    # its own, forked away from this script: started from an agent's Bash
    # command it would otherwise stay in that command's process group,
    # which the live runner notes and stops whenever it restarts (the app,
    # launched through open, survived that and lost its runner).
    /usr/bin/perl -MPOSIX -e '
      my $pidfile = shift;
      defined(my $pid = fork) or die "fork: $!";
      exit 0 if $pid;
      POSIX::setsid();
      open(my $f, ">", $pidfile) or die "$pidfile: $!";
      print $f $$;
      close $f;
      exec @ARGV or die "exec: $!";
    ' "$dir/mock.pid" "$node" "$TOOLS_DIR/mock-runner/server.mjs" --data-dir "$data" "${args[@]}" --ready-file "$dir/mock.port" \
      --exit-with-pid-file "$dir/app.pid" >"$dir/mock.log" 2>&1 </dev/null
    local i
    for i in $(seq 1 200); do [ -s "$dir/mock.pid" ] && break; sleep 0.05; done
    [ -s "$dir/mock.pid" ] || { tail -n 20 "$dir/mock.log" >&2; die "the mock runner didn't start"; }
    echo "mock_pid=$(cat "$dir/mock.pid")" >>"$dir/instance"
    for i in $(seq 1 200); do [ -f "$dir/mock.port" ] && break; sleep 0.05; done
    [ -f "$dir/mock.port" ] || { tail -n 20 "$dir/mock.log" >&2; die "the mock runner didn't start"; }
  else
    runner="home $data"
  fi
  {
    echo "data=$data"
    echo "runner=$runner"
  } >>"$dir/instance"
  load_instance "$ID"

  {
    printf '%s\n' --data-dir "$data" --automation "$dir/automation.log" --automation-id "$ID" --app-log "$dir/app.log" \
      --automation-idle-quit "$IDLE_QUIT_SECONDS"
    [ -z "$appearance" ] || printf '%s\n' --appearance "$appearance"
    [ -z "$size" ] || printf '%s\n' --window-size "$size"
    # The date the bear goes by: its Santa hat, and bedtime under an empty Inbox.
    [ -z "$bear_date" ] || printf '%s\n' -ThreadbearBearDate "$bear_date"
  } >"$dir/app.args"
  launch_app
  trap - ERR
  CLEANUP_ID=""

  echo "Started dev app $ID (pid $I_PID) on $( [ "$runner" = mock ] && echo "the mock runner" || echo "the runner at $data" )."
  echo "  data folder: $data"
  if [ -n "$home" ] && [ -z "$runner_model" ]; then
    # A runner.json from before dev-runner.sh set a default model: a
    # thread started from the composer would run on the account's own.
    send '{"cmd":"options","model":"claude-haiku-5-5"}' >/dev/null || true
    echo "  That runner has no default model (runner.json defaults.model), so the composer's model is set to"
    echo "  claude-haiku-5-5 for the next new thread only. Set it again before each one: do '{\"cmd\":\"options\",\"model\":\"claude-haiku-5-5\"}'."
  fi
  echo "  Tools/dev-app.sh --id $ID do '{\"cmd\":\"open\",\"id\":\"<thread>\"}'   dump   shot <file.png>   rebuild   log   stop"
}

# do, shot, dump and rebuild need the app up, and a mock instance its mock.
require_running() {
  app_running || die "dev app $I_ID has quit (after 60 minutes with no command, or it crashed: Tools/dev-app.sh --id $I_ID log). Stop it and start a new one."
  if [ "$I_RUNNER" = mock ] && ! mock_running; then
    die "dev app $I_ID's mock runner has stopped (Tools/dev-app.sh --id $I_ID log --mock says why), so the app can't reach a runner. Stop it and start a new one."
  fi
}

cmd_do() {
  local timeout="" commands=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) timeout="${2:?--timeout needs seconds}"; shift ;;
      --id) ID="${2:?--id needs an id}"; shift ;;
      *) commands+=("$1") ;;
    esac
    shift
  done
  [ ${#commands[@]} -gt 0 ] || die "do needs at least one '<json>' command"
  use_instance
  require_running
  local command
  for command in "${commands[@]}"; do
    send "$command" "$timeout" || exit 1
  done
}

# Opens a real menu and captures its window, the only way to see its icons.
# It's on the screen for a second, over whatever's in front.
cmd_menu() {
  local file="${1:-}" spec="${2:-}"
  [ -n "$file" ] && [ -n "$spec" ] || die "usage: menu <file.png> '{\"x\":854,\"y\":19}' (see realMenu in README)"
  case "$file" in /*) ;; *) file="$PWD/$file" ;; esac
  local idfile; idfile="$(mktemp)"; rm -f "$idfile" "$file"
  local extra="\"cmd\":\"realMenu\",\"hold\":1.0,\"idFile\":\"$idfile\","
  cmd_do "{$extra${spec#\{}" &
  local waiting=$! i
  for i in $(seq 1 60); do [ -s "$idfile" ] && break; sleep 0.05; done
  [ -s "$idfile" ] && /usr/sbin/screencapture -o -x -l "$(cat "$idfile")" "$file" >/dev/null 2>&1
  wait "$waiting"
  rm -f "$idfile"
  [ -s "$file" ] || die "no menu shot"
  echo "menu shot $file"
}

cmd_shot() {
  local file="" sheet=false settings=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --id) ID="${2:?--id needs an id}"; shift ;;
      # The sheet over the window (the schedule editor) instead of the window.
      --sheet) sheet=true ;;
      # The Settings window (open it first with do '{"cmd":"settings"}').
      --settings) settings=true ;;
      *) [ -z "$file" ] || die "shot takes one file"; file="$1" ;;
    esac
    shift
  done
  [ -n "$file" ] || die "shot needs a file (.png)"
  case "$file" in /*) ;; *) file="$PWD/$file" ;; esac
  use_instance
  require_running
  # screencapture runs here, in the agent's shell: the instance's temp
  # bundle has no Screen Recording permission, so from inside the app it
  # always fell back to the app's own drawing (and macOS may ask Mike).
  local line wid
  line="$(send "{\"cmd\":\"window\",\"sheet\":$sheet,\"settings\":$settings}")" || exit 1
  wid="$(printf '%s' "$line" | awk '{ print $3 }')"
  mkdir -p "$(dirname "$file")"
  rm -f "$file"
  if [[ "$wid" =~ ^[0-9]+$ ]] && /usr/sbin/screencapture -o -x -l "$wid" "$file" >/dev/null 2>&1 && [ -s "$file" ]; then
    echo "screenshot ok $file (screencapture)"
    return 0
  fi
  rm -f "$file"
  # The app draws it into its own folder and this shell moves it: the temp
  # bundle writing into Desktop, Documents or Downloads would put a macOS
  # access prompt in front of Mike.
  local drawn="$I_DIR/shot.png"
  rm -f "$drawn"
  send "{\"cmd\":\"screenshot\",\"inProcess\":true,\"sheet\":$sheet,\"settings\":$settings,\"path\":$(json_string "$drawn")}" >/dev/null || exit 1
  mv "$drawn" "$file"
  echo "screenshot ok $file (in-process)"
  echo "dev-app: screencapture gave no image (the screen is locked or asleep, or this shell has no Screen Recording permission), so that's the app's own drawing: the sidebar's glass is a flat fill and the traffic lights are approximate." >&2
}

cmd_dump() {
  local format=text
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) format=json ;;
      --id) ID="${2:?--id needs an id}"; shift ;;
      *) die "unknown option for dump: $1" ;;
    esac
    shift
  done
  use_instance
  require_running
  local out="$I_DIR/dump.$format"
  send "{\"cmd\":\"dump\",\"format\":\"$format\",\"out\":$(json_string "$out")}" >/dev/null || exit 1
  cat "$out"
}

cmd_rebuild() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --id) ID="${2:?--id needs an id}"; shift ;;
      *) die "unknown option for rebuild: $1" ;;
    esac
    shift
  done
  use_instance
  require_running
  [ -f "$I_DIR/app.args" ] || die "$I_ID was started by an older dev-app.sh; stop it and start a new one"
  local status selection
  status="$(send '{"cmd":"status"}')" || exit 1
  selection="$(printf '%s' "$status" | sed -n 's/.*"selection":"\([^"]*\)".*/\1/p')"
  echo "Building the debug app..."
  # The running app stays up if the build fails.
  build_binary "$I_ID" || exit 1
  # So reap leaves it while the old app's gone and the new one isn't up.
  set_field starter "$$"
  set_field starter_since "$(started_at $$)"
  # Before the quit: the mock checks app.pid every 2 s and exits once that
  # app is gone, and a check landing between the quit and the removal used
  # to take the mock (and its state) down with the old build. A missing
  # file is fine for 2 minutes.
  rm -f "$I_DIR/app.pid"
  send '{"cmd":"quit"}' 5 >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 100); do alive "$I_PID" || break; sleep 0.05; done
  app_running && kill "$I_PID" 2>/dev/null || true
  for i in $(seq 1 100); do alive "$I_PID" || break; sleep 0.05; done
  install_bundle
  launch_app
  if [ -n "$selection" ]; then
    send "{\"cmd\":\"open\",\"id\":$(json_string "$selection")}" >/dev/null || echo "dev-app: couldn't reopen $selection" >&2
  fi
  echo "Rebuilt dev app $I_ID (pid $I_PID)${selection:+, with $selection open again}."
}

cmd_log() {
  local follow="" lines=200 which=app
  while [ $# -gt 0 ]; do
    case "$1" in
      -f) follow=-f ;;
      -n) lines="${2:?-n needs a number}"; shift ;;
      --mock) which=mock ;;
      --automation) which=automation ;;
      --id) ID="${2:?--id needs an id}"; shift ;;
      *) die "unknown option for log: $1" ;;
    esac
    shift
  done
  use_instance any
  local file="$I_DIR/$which.log"
  [ -f "$file" ] || die "no $which log for $I_ID"
  tail -n "$lines" $follow "$file"
}

# Quits the app (the quit command, then a kill of the pid start recorded if
# it's still that bundle's binary), stops the mock if it's this instance's,
# and removes everything the instance made, settings included.
stop_one() {
  load_instance "$1"
  # A start that failed before it wrote the pid down.
  [ -n "$I_PID" ] || [ -z "$I_BUNDLE" ] || I_PID="$(bundle_pid "$I_BUNDLE")"
  if alive "$I_PID"; then
    send '{"cmd":"quit"}' 5 >/dev/null 2>&1 || true
    local i
    for i in $(seq 1 100); do alive "$I_PID" || break; sleep 0.05; done
    if alive "$I_PID" && ps -p "$I_PID" -o command= | grep -qF "$I_BUNDLE/Contents/MacOS/Threadbear"; then
      kill "$I_PID" 2>/dev/null || true
    fi
  fi
  if alive "$I_MOCK_PID" && ps -p "$I_MOCK_PID" -o command= | grep -qF "$I_DIR/data"; then
    kill "$I_MOCK_PID" 2>/dev/null || true
  fi
  [ -z "$I_BUNDLE" ] || [ ! -d "$I_BUNDLE" ] || "$LSREGISTER" -u "$I_BUNDLE" >/dev/null 2>&1 || true
  # Only ever this instance's own bundle id. With ApplePersistenceIgnoreState
  # the app keeps its saved state in the per-user temp folder.
  case "$I_BUNDLE_ID" in
    "$BUNDLE_PREFIX".?*)
      defaults delete "$I_BUNDLE_ID" >/dev/null 2>&1 || true
      rm -rf "$HOME/Library/Preferences/$I_BUNDLE_ID.plist" "$HOME/Library/Saved Application State/$I_BUNDLE_ID.savedState" \
        "$(getconf DARWIN_USER_TEMP_DIR)$I_BUNDLE_ID.savedState" \
        "$HOME/Library/Caches/$I_BUNDLE_ID" "$HOME/Library/HTTPStorages/$I_BUNDLE_ID" "$HOME/Library/HTTPStorages/$I_BUNDLE_ID.binarycookies"
      ;;
  esac
  # Not its failed build's log: a start that fails cleans up with this,
  # and the log is what it points at. reap prunes old ones.
  rm -rf "$I_DIR"
  echo "Stopped dev app $1."
}

cmd_stop() {
  local which=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) which=mine ;;
      --everyone) which=everyone ;;
      --id) ID="${2:?--id needs an id}"; shift ;;
      *) die "unknown option for stop: $1" ;;
    esac
    shift
  done
  if [ -n "$which" ]; then
    local id any=""
    for id in $(all_ids); do
      load_instance "$id"
      [ "$which" = everyone ] || is_mine || continue
      any=1
      stop_one "$id"
    done
    [ -n "$any" ] || echo "No dev apps$( [ "$which" = mine ] && echo " of yours")."
    return
  fi
  use_instance any
  stop_one "$I_ID"
}

cmd_status() {
  reap
  local id found="" default=""
  default="$(default_id)"
  for id in $(all_ids); do
    found=1
    load_instance "$id"
    local state="quit (stop cleans it up)"
    if app_running; then
      state="running, pid $I_PID"
      # The app outlives its runner: the mock stopped (a runner restart used
      # to stop it), or the dev runner was killed. Only dump said so.
      if [ "$I_RUNNER" = mock ]; then mock_running || state="$state, but its mock runner has stopped"
      elif [ -n "$I_DATA" ]; then home_runner_running || state="$state, but its runner isn't running"
      fi
    fi
    [ -n "$I_PID" ] || state="starting"
    printf '%s %-8s %s; %s; %s\n' "$( [ "$id" = "$default" ] && echo '*' || echo ' ')" "$id" "$state" \
      "$( [ "$I_RUNNER" = mock ] && echo "mock runner (data $I_DATA)" || echo "runner at ${I_RUNNER#home }")" "$(whose)"
  done
  if [ -z "$found" ]; then echo "No dev apps. Start one with Tools/dev-app.sh start --mock."; return; fi
  [ -z "$default" ] || echo "* is the one commands without --id use."
}

# ------------------------------------------------------------------ main

ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID="${2:?--id needs an id}"; shift 2 ;;
    -h|--help|help) usage; exit 0 ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { usage; exit 2; }
command="$1"
shift
case "$command" in
  start) cmd_start "$@" ;;
  do) cmd_do "$@" ;;
  shot) cmd_shot "$@" ;;
  menu) cmd_menu "$@" ;;
  dump) cmd_dump "$@" ;;
  rebuild) cmd_rebuild "$@" ;;
  log) cmd_log "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status ;;
  *) usage >&2; exit 2 ;;
esac
