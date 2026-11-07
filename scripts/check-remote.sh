#!/bin/bash
# Runs ./check.sh on another Mac, so test suites and the app's test windows
# don't load the Mac you're working on. check.sh calls this itself when a
# check host is set (THREADBEAR_CHECK_HOST, or "checkHost" in runner.json);
# you don't run it by hand.
#
#   scripts/check-remote.sh <ssh host>[,<ssh host>...] [check.sh options]
#
# With several hosts (Mike's are Tinker Desk and the cloud box), each run
# goes to the first one that's free and can run it, or waits for the first
# that can. A Linux host only takes what needs no Mac: a --quick run that
# doesn't touch ios/ (ThreadbearKit's tests are Swift), with no --shots.
# Mike asked on 6 Nov, when nine threads' checks queued at once.
#
# Mike asked on 6 Nov 2026, after three threads' unit suites, a swift test
# and three debug apps took his M5 to a load of 75 and a test's window came
# up over his browser. The host he picked (Tinker Desk) is also where he
# tries clean installs of Threadbear, so a run leaves nothing behind that
# looks like an install: no runner, no data dir, no checkout. Each run
# copies this checkout's files (tracked and untracked, as check.sh sees
# them) into ~/.cache/threadbear-check/runs/<id> there, runs check.sh on
# it, and deletes it. What's kept there between runs is only what makes
# the next run quick: node_modules per lockfile, the Swift build folders,
# and a mirror of each checkout that sends to it (mirror/<key>), so a run
# sends only what changed since that checkout's last, compressed: a whole
# copy is 17 MB, and on a congested link (6 Nov) that took minutes. Each
# run's copy is made from the mirror there. Delete ~/.cache/threadbear-check
# to take it all away.
#
# One run at a time on the host (lockf); a second waits and says so. The
# copy always runs from the same path, src/, as SwiftPM's build cache only
# works where it was made. Logs of failed steps, and --shots, come back
# here. --e2e never comes here: it needs the claude login, and on Tinker
# Desk a CLI signed in over SSH broke the desktop's login (2 Nov), so
# check.sh runs those on this Mac.
#
# A host with too little disk left is passed over (MIN_FREE_GIB, below).
#
# Exit 255: no host that can run it could be reached (check.sh then runs here).
# Hosts that were reached but have no room are exit 1, with their free space:
# the M5 isn't the place for it either, and clearing the host is the fix.
set -uo pipefail

BASE_REL=".cache/threadbear-check"
# Available KiB where the run's files go, as one number. -P keeps each disk
# on one line and the columns the same on macOS and Linux.
free_cmd='df -Pk . 2>/dev/null | awk "END { print \$4 }"'

# ---- On the check host: scripts/check-remote.sh --on-host <id> [options]
if [ "${1:-}" = "--on-host" ]; then
  id="$2"
  shift 2
  base="$HOME/$BASE_REL"
  src="$base/src"
  NODE="$HOME/.nvm/versions/node/v24.22.1/bin/node"
  export PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
  # Everything the tests make in a temp folder goes here and is deleted
  # with the run, so nothing piles up in /var/folders.
  export TMPDIR="$base/tmp-$id"
  rm -rf "$src" "$TMPDIR"
  # Anything a run cut short left (a copy that never got the lock, logs
  # nobody fetched) goes after half a day.
  find "$base/runs" "$base" -mindepth 1 -maxdepth 1 \( -name '[0-9]*' -o -name 'tmp-*' -o -name 'kept-*' -o -name 'shots-*' \) \
    -mmin +720 -exec rm -rf {} + 2>/dev/null
  # A checkout's mirror that hasn't sent a run for a week (a removed worktree).
  find "$base/mirror" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
  mkdir -p "$TMPDIR"
  mv "$base/runs/$id" "$src" || { echo "The copy for run $id isn't on $(hostname -s)." >&2; exit 1; }
  # A failed check keeps its logs in $TMPDIR; they move aside for this
  # Mac to fetch, and everything else goes.
  keep_logs() {
    local rc=$?
    cd "$base" || return
    # A failed run's free space, before its temp files go: if they're what
    # filled the disk, it'd look fine by the time this Mac asks (Codex's
    # review). The Mac falls back to asking if a full disk stops this write.
    if [ "$rc" != 0 ] && mkdir -p "$base/kept-$id" 2>/dev/null; then
      eval "$free_cmd" >"$base/kept-$id/free-kb" 2>/dev/null
    fi
    for d in "$TMPDIR"/threadbear-check.*; do
      [ -d "$d" ] && mkdir -p "$base/kept-$id" && mv "$d" "$base/kept-$id/"
    done
    rm -rf "$src" "$TMPDIR"
  }
  trap keep_logs EXIT

  # A git repo of its own, on main, as some tests run git in the repo
  # (deploy-backend.mjs reads HEAD). Its one commit is the copy as sent.
  (cd "$src" && git init -q -b main && git add -A && git -c user.name=check -c user.email=check@localhost commit -qm "check copy") \
    || { echo "Couldn't make the copy a git repo." >&2; exit 1; }

  # node_modules per package-lock, kept between runs (the newest three of
  # each). npm ci only when the lockfile is new.
  for dir in . runner app/Tools/mock-runner; do
    [ -f "$src/$dir/package-lock.json" ] || continue
    name="$(printf '%s' "$dir" | tr -c 'a-zA-Z0-9' '-')"
    hash="$(shasum -a 256 "$src/$dir/package-lock.json" | cut -c1-16)"
    # The folder itself has to be called node_modules: Node finds a
    # package's own dependencies from its real path, by looking for
    # node_modules folders above it.
    cache="$base/deps/$name-$hash/node_modules"
    if [ ! -d "$cache" ]; then
      echo "npm ci in $dir (its lockfile is new here)"
      (cd "$src/$dir" && npm ci --no-audit --no-fund --loglevel=error >/dev/null) || { echo "npm ci failed in $dir" >&2; exit 1; }
      mkdir -p "$(dirname "$cache")"
      mv "$src/$dir/node_modules" "$cache"
    fi
    touch "$(dirname "$cache")"
    rm -rf "$src/$dir/node_modules"
    ln -s "$cache" "$src/$dir/node_modules"
    ls -td "$base/deps/$name-"* 2>/dev/null | tail -n +4 | xargs rm -rf
  done
  # The Swift build folders, kept between runs.
  for dir in app dock ios/ThreadbearKit; do
    [ -d "$src/$dir" ] || continue
    name="$(printf '%s' "$dir" | tr -c 'a-zA-Z0-9' '-')"
    mkdir -p "$base/build/$name"
    rm -rf "$src/$dir/.build"
    ln -s "$base/build/$name" "$src/$dir/.build"
  done

  cd "$src" || exit 1
  THREADBEAR_CHECK_CHANGED_FILE="$src/.check-changed" THREADBEAR_NODE="$NODE" ./check.sh --local "$@"
  exit $?
fi

# ---- On this Mac
HOST_LIST="${1:?usage: check-remote.sh <ssh host>[,<ssh host>...] [check.sh options]}"
shift
read -ra HOSTS <<<"$(printf '%s' "$HOST_LIST" | tr ',' ' ')"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A folder only this account can use: it exists (made here if not, mode
# 0700), isn't a symlink, is owned by this user and has mode 0700 exactly.
# One that's anything else is never repaired or used (Daybreak, 7 Nov: a
# name in a shared folder like /tmp can be taken by another account first).
MY_UID="$(id -u)"
owner_mode() {
  if [ "$(uname -s)" = Darwin ]; then stat -f '%u %Lp' "$1" 2>/dev/null; else stat -c '%u %a' "$1" 2>/dev/null; fi
}
private_dir() {
  [ -e "$1" ] || [ -L "$1" ] || mkdir -m 700 "$1" 2>/dev/null
  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(owner_mode "$1")" = "$MY_UID 700" ]
}
# Only these characters in a path this script builds commands from: ssh
# and rsync's -e split on spaces, and the host's commands quote with '.
plain_path() {
  case "$1" in /*) ;; *) return 1 ;; esac
  # Byte by byte, in the C locale: a bracket range in a UTF-8 locale
  # took é for a letter on Linux. Counted, not captured, as $() drops a
  # newline at the end (Codex's review).
  local odd
  odd="$(printf '%s' "$1" | LC_ALL=C tr -d 'A-Za-z0-9._/-' | wc -c)"
  [ $((odd)) -eq 0 ] || return 1
  case "/$1/" in */../*|*/./*) return 1 ;; esac
}

# One connection per host, shared by every ssh and rsync this run makes:
# a run makes half a dozen, and on a congested link (6 Nov, 2 s pings) each
# new one took 20 s to set up. Its socket is in ~/.ssh/tbc, a folder of this
# user's own (above): it was /tmp/tbc-<uid>-%C, a name another account on
# the Mac could make first and so answer for the host (Daybreak, 7 Nov).
# A socket's path can't be long: ssh binds <path>.<16 random> first, %C is
# 40 characters, and macOS allows 103 (Linux 107). Too long, or no private
# folder, and each ssh makes its own connection instead.
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=30 -o ServerAliveCountMax=4)
sock_dir="${HOME:-}/.ssh/tbc"
if plain_path "$sock_dir" && [ $(( ${#sock_dir} + 1 + 40 + 17 )) -le 103 ] \
  && { [ -d "$HOME/.ssh" ] || mkdir -m 700 "$HOME/.ssh" 2>/dev/null; } && private_dir "$sock_dir"; then
  SSH+=(-o ControlMaster=auto -o "ControlPath=$sock_dir/%C" -o ControlPersist=60)
else
  echo "Not sharing one ssh connection per host: $sock_dir isn't a short folder of this user's own (mode 700)." >&2
  SSH+=(-o ControlMaster=no -o ControlPath=none)
fi

ARGS=()
SHOTS=""
QUICK=0
ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --shots)
      case "$2" in /*) SHOTS="$2" ;; *) SHOTS="$PWD/$2" ;; esac
      shift ;;
    --quick) QUICK=1; ARGS+=("$1") ;;
    --all) ALL=1; ARGS+=("$1") ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

# What this checkout changes from main, worked out here where the history
# is (the copy's git has just one commit), as check.sh skips steps by it
# (see `needed` there).
changed="$(mktemp)"
{
  base="$(git -C "$ROOT" merge-base HEAD main 2>/dev/null)" && git -C "$ROOT" diff --name-only "$base"
  git -C "$ROOT" ls-files --others --exclude-standard
} 2>/dev/null | sort -u >"$changed"

# Whether a Linux host can run this: only the runner's, Convex's and the
# website's checks, so --quick, nothing changed under ios/ (and something
# changed: with nothing, check.sh itself or --all, it runs everything), no
# shots.
linux_ok=0
if [ "$QUICK" = 1 ] && [ "$ALL" = 0 ] && [ -z "$SHOTS" ] && [ -s "$changed" ] && ! grep -qE '^ios/|^check\.sh$' "$changed"; then linux_ok=1; fi

# The disk a run wants free on its host. On 7 Nov Tinker Desk fell under 1 GiB
# and an --app check died with a CodeSign error that said nothing about space,
# which cost a landing. Sized for a host starting cold, from Tinker Desk that
# day: anything building Swift can write 2.4 GiB of build folders, 2.3 of
# SwiftPM's cache and 0.6 of node_modules, about 5.5 GiB, and 8 leaves macOS
# room to work. A run with no Swift (what a Linux host can take, so linux_ok
# says which) writes only the node_modules and its temp files.
MIN_FREE_GIB=8
[ "$linux_ok" = 0 ] || MIN_FREE_GIB=2

# Whether a df answer is under the limit: 0 yes, and FREE_GIB is it to one
# place, rounded down; 1 no; 2 it isn't a number we can use. It's the host's
# word, so it's only compared, and the digits are spelled out because a
# bracket range in a UTF-8 locale can take in other characters. Rounded down,
# as "8.0 free, needs 8" would make no sense.
FREE_GIB=""
low_on_room() {
  case "$1" in ""|*[!0123456789]*) return 2 ;; esac
  # More digits than any disk has would wrap around in bash's arithmetic.
  [ "${#1}" -le 15 ] || return 2
  local kb=$((10#$1))
  [ "$kb" -lt $((MIN_FREE_GIB * 1048576)) ] || return 1
  FREE_GIB="$((kb / 1048576)).$(((kb % 1048576) * 10 / 1048576))"
}
# The host just used, asked again after something failed there: true, with
# FREE_GIB set, if it's low. Not if it's fine or can't be asked.
host_is_low() {
  local kb
  kb="$("${SSH[@]}" "$HOST" "cd '$remote_base' && $free_cmd" 2>/dev/null)" && low_on_room "$kb"
}

# Each host: reachable, its system, whether its lock is free now, and how much
# disk it has left. The first free one that can run it wins; otherwise the
# first that can, which then waits for its lock. Two checks can both see a host
# free, so a run there takes the lock without waiting (exit 75 if it can't),
# and the one that lost chooses again; after three goes it waits in line.
probe='mkdir -p ~/'"$BASE_REL"'/runs && cd ~/'"$BASE_REL"' && pwd && uname -s && if [ "$(uname -s)" = Darwin ]; then /usr/bin/lockf -t 0 lock true 2>/dev/null && echo free || echo busy; else flock -n lock true 2>/dev/null && echo free || echo busy; fi && '"$free_cmd"
# Hosts with no room, as "<host> has <n> GiB free": those this choosing passed
# over, and those whose copy failed for lack of it, which aren't asked again.
LOW="" LOW_COPY=""
pass_over() {
  echo "Passing over $1: it has $FREE_GIB GiB free, and this check wants $MIN_FREE_GIB GiB." >&2
  LOW+="${LOW:+, }$1 has $FREE_GIB GiB free"
}
choose() {
  HOST="" HOST_OS="" remote_base="" FREE=0 LOW="$LOW_COPY"
  local first="" first_os="" first_base="" h out rc b os state kb
  for h in "${HOSTS[@]}"; do
    # An ssh host, never something ssh would take for an option.
    case "$h" in -*|"") continue ;; esac
    # One that dropped out during a copy this run isn't tried again.
    case " $SKIP " in *" $h "*) continue ;; esac
    out="$("${SSH[@]}" "$h" "$probe" 2>/dev/null)"
    rc=$?
    if [ "$rc" != 0 ]; then
      # It answered, but a disk too full for the probe's mkdir fails it too,
      # and calling that unreachable would run the check on this Mac (Codex's
      # review). 255 is ssh itself: nobody there to ask.
      if [ "$rc" != 255 ] && kb="$("${SSH[@]}" "$h" "cd ~ && $free_cmd" 2>/dev/null)" && low_on_room "$kb"; then
        pass_over "$h"
      else
        echo "Couldn't reach $h over ssh." >&2
      fi
      continue
    fi
    { read -r b; read -r os; read -r state; read -r kb; } <<<"$out"
    # Every rm -rf over there is under this, so never let it be empty. It's
    # the host's word, so it's only ever data: an absolute path of plain
    # characters ending in the folder asked for, else the host is passed
    # over (Daybreak, 7 Nov: it went into a sed program here).
    if ! plain_path "$b"; then echo "Unexpected folder on $h (not a plain absolute path); passing it over." >&2; continue; fi
    case "$b" in */$BASE_REL) ;; *) echo "Unexpected folder on $h: '$b'" >&2; continue ;; esac
    case "$os" in
      Darwin) ;;
      Linux) [ "$linux_ok" = 1 ] || continue ;;
      *) continue ;;
    esac
    # After the system, so a host that couldn't run this anyway isn't named.
    # Busy or free alike: waiting for a full disk gets nobody anywhere.
    low_on_room "$kb"
    case $? in
      0)
        pass_over "$h"
        continue ;;
      # Not knowing is no reason to stop checks; a failure there still says.
      2) echo "Couldn't read how much disk $h has free; trying it anyway." >&2 ;;
    esac
    if [ "$state" = free ]; then HOST="$h" HOST_OS="$os" remote_base="$b" FREE=1; return 0; fi
    [ -n "$first" ] || { first="$h" first_os="$os" first_base="$b"; }
  done
  [ -n "$first" ] || return 1
  HOST="$first" HOST_OS="$first_os" remote_base="$first_base"
}

# The files check.sh would see, less what no check reads: the pictures in
# docs/ and site/ (about 50 MB of the repo). TourTests reads site's JSON.
files="$(mktemp)"
(cd "$ROOT" && git ls-files -co --exclude-standard -z) | tr '\0' '\n' \
  | grep -vE '^(docs|site)/.*\.(png|gif|jpe?g|mp4|mov|webp)$' | tr '\n' '\0' >"$files"
BASE_ARGS=(${ARGS[@]+"${ARGS[@]}"})
SKIP=""
tries=0
# The copy lock: a kernel lock (lockf, or flock on Linux) held by a small
# helper until this run lets go or ends, so one a killed run held frees
# itself. The helper looks every second for its release file and for
# this script.
#
# The lock file is shared by every run from this checkout, so it lives in a
# folder of this user's own (private_dir); the helper's ready and release
# files are this run's alone, in a folder mktemp -d makes (0700, atomically).
# Both were names in $TMPDIR that mktemp -u only made up, not made, which
# another account could have put a link at first (Daybreak, 7 Nov).
holder="" release="" sentinels=""
lock_dir="${XDG_CACHE_HOME:-${HOME:-}/.cache}/threadbear-check-locks"
take_copylock() {
  local ready
  if [ -z "$sentinels" ]; then
    sentinels="$(mktemp -d "${TMPDIR:-/tmp}/tb-check-lock.XXXXXX")" || { sentinels=""; return 1; }
  fi
  ready="$sentinels/ready"
  release="$sentinels/release"
  rm -f "$ready" "$release"
  local hold=': >"$1"; while kill -0 "$2" 2>/dev/null && [ ! -e "$3" ]; do sleep 1; done'
  if command -v flock >/dev/null 2>&1; then flock "$1" /bin/sh -c "$hold" sh "$ready" "$$" "$release" &
  else /usr/bin/lockf -k "$1" /bin/sh -c "$hold" sh "$ready" "$$" "$release" & fi
  holder=$!
  until [ -e "$ready" ] || ! kill -0 "$holder" 2>/dev/null; do sleep 0.2; done
  # The helper gone with no ready file never had the lock (a lock file it
  # can't open): no copy without it.
  if [ ! -e "$ready" ]; then
    wait "$holder" 2>/dev/null
    rm -f "$release"
    holder="" release=""
    return 1
  fi
  rm -f "$ready"
}
drop_copylock() {
  [ -n "$holder" ] || return 0
  : >"$release"
  wait "$holder" 2>/dev/null
  rm -f "$release"
  holder="" release=""
}
finish() {
  drop_copylock
  [ -z "$sentinels" ] || rm -rf "$sentinels"
}
trap finish EXIT
# Each line with `from` and the letters and digits after it (a log folder's
# mktemp suffix) changed to `to`, as the check runs, line by line. Both are
# plain text, read from the environment so neither is ever part of a
# program: this was a sed program with the host's folder spliced into it
# (Daybreak, 7 Nov). ENVIRON, not -v, which would read backslashes.
rewrite_logs() {
  LC_ALL=C REWRITE_FROM="$1" REWRITE_TO="$2" awk '
    BEGIN { from = ENVIRON["REWRITE_FROM"]; to = ENVIRON["REWRITE_TO"]; n = length(from) }
    {
      line = $0; out = ""
      while (n > 0 && (i = index(line, from)) > 0) {
        out = out substr(line, 1, i - 1) to
        line = substr(line, i + n)
        match(line, /^[A-Za-z0-9]*/)
        line = substr(line, RLENGTH + 1)
      }
      print out line
      fflush()
    }'
}
# The host that has this run's copy, and how long it took. A run that loses
# the race for a free host keeps its copy: copying again is what costs, as
# over a slow uplink a first copy took 22 minutes (6 Nov), and one thread's
# app check copied, lost, deleted and copied again. After a slow copy it
# waits in line on that host; after a quick one it chooses again, reusing
# the copy if that's the same host. THREADBEAR_CHECK_STAY_SECS is for the
# tests.
copied_host="" copy_secs=0
stay_secs="${THREADBEAR_CHECK_STAY_SECS:-60}"
while :; do
  # A disk that's filled up since (the check that won may have done it) is no
  # place to wait: choosing again passes it over and deletes the copy.
  if [ -n "$copied_host" ] && [ "$copy_secs" -ge "$stay_secs" ] && ! host_is_low; then
    # HOST, HOST_OS and remote_base are still the copy's.
    FREE=0
  elif ! choose; then
    [ -z "$copied_host" ] || "${SSH[@]}" "$copied_host" "rm -rf '$remote_run'" 2>/dev/null
    rm -f "$files" "$changed"
    if [ -n "$LOW" ]; then
      # Not 255: a disk to clear isn't a reason to run it all on this Mac.
      echo "No check host has room for this check: $LOW, and it wants $MIN_FREE_GIB GiB. Free some space there and run it again." >&2
      exit 1
    fi
    echo "None of $HOST_LIST can run this check now." >&2
    exit 255
  fi
  if [ "$HOST" = "$copied_host" ]; then
    echo "Checking on $HOST (its copy is already there)"
  else
    [ -z "$copied_host" ] || "${SSH[@]}" "$copied_host" "rm -rf '$remote_run'" 2>/dev/null
    copied_host=""
    id="$(date +%H%M%S)-$$-$tries"
    remote_run="$remote_base/runs/$id"
    start=$SECONDS
    # This checkout's mirror on the host: one per Mac and checkout, so two
    # worktrees never write the same one. Only what changed goes over the
    # link; the run's copy is made from it there, of exactly this run's files
    # (a file deleted here stays in the mirror but isn't copied).
    key="$(printf '%s' "$(hostname -s):$ROOT" | shasum | cut -c1-16)"
    mirror="$remote_base/mirror/$key"
    # Two checks from this checkout at once take turns at the mirror, from
    # the upload until the run's copy is made, so neither copies the other's
    # files.
    copylock="$lock_dir/copy-$key-$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9._-' '_').lock"
    if ! { [ -d "$(dirname "$lock_dir")" ] || mkdir -p "$(dirname "$lock_dir")"; } || ! private_dir "$lock_dir" || ! take_copylock "$copylock"; then
      rm -f "$files" "$changed"
      # Not 255: running it here instead isn't the answer to a broken lock.
      echo "Couldn't take the lock on this checkout's copy ($copylock; its folder must be this user's own, mode 700)." >&2
      exit 1
    fi
    # By content (-c), not size and time: an edit that keeps both would
    # otherwise leave the mirror's old copy in the run.
    if ! "${SSH[@]}" "$HOST" "mkdir -p '$mirror' '$remote_run' && touch '$mirror'" \
      || ! rsync -azc --from0 --files-from="$files" -e "${SSH[*]}" "$ROOT/" "$HOST:$mirror/" \
      || ! rsync -a -e "${SSH[*]}" "$files" "$HOST:$remote_run.files" \
      || ! "${SSH[@]}" "$HOST" "rsync -a --from0 --files-from='$remote_run.files' '$mirror/' '$remote_run/' && rm -f '$remote_run.files'" \
      || ! rsync -a -e "${SSH[*]}" "$changed" "$HOST:$remote_run/.check-changed"; then
      drop_copylock
      "${SSH[@]}" "$HOST" "rm -rf '$remote_run' '$remote_run.files'" 2>/dev/null
      # The next host that can run it, before this Mac (6 Nov: Tinker Desk
      # dropped off mid-copy and the check ran on the M5).
      if host_is_low; then
        echo "Couldn't copy this checkout to $HOST (it has $FREE_GIB GiB free, and this check wants $MIN_FREE_GIB GiB); trying the others." >&2
        LOW_COPY+="${LOW_COPY:+, }$HOST has $FREE_GIB GiB free"
      else
        echo "Couldn't copy this checkout to $HOST; trying the others." >&2
      fi
      SKIP+=" $HOST"
      continue
    fi
    drop_copylock
    copied_host="$HOST" copy_secs=$((SECONDS - start))
    echo "Checking on $HOST (copied in ${copy_secs}s; THREADBEAR_CHECK_HOST= ./check.sh --local runs here)"
  fi

  ARGS=(${BASE_ARGS[@]+"${BASE_ARGS[@]}"})
  remote_shots=""
  [ -z "$SHOTS" ] || { remote_shots="$remote_base/shots-$id"; ARGS+=(--shots "$remote_shots"); }

  quoted=""
  for a in ${ARGS[@]+"${ARGS[@]}"}; do quoted+=" $(printf '%q' "$a")"; done
  inner="/bin/bash $(printf '%q' "$remote_run/scripts/check-remote.sh") --on-host $id$quoted"
  # The design screenshots go through Desk Runner, which has Screen Recording
  # there; over plain ssh they'd be drawn in-process, with the sidebar's
  # glass a flat fill.
  [ -z "$SHOTS" ] || inner="\$HOME/.local/bin/desk $(printf '%q' "$inner")"
  lock="$remote_base/lock"
  # A free host is taken without waiting (75 if another check got there
  # first); otherwise this waits for its turn.
  now=0
  [ "$FREE" = 1 ] && [ "$tries" -lt 3 ] && now=1
  if [ "$HOST_OS" = Linux ]; then
    # A server that runs its own runner and threads: the check goes in under them.
    run="nice -n 10 /bin/bash -c $(printf '%q' "$inner")"
    if [ "$now" = 1 ]; then remote_cmd="flock -n -E 75 $lock $run"
    else remote_cmd="flock -n $lock true 2>/dev/null || echo 'Waiting for another check on $HOST to finish...'; flock $lock $run"; fi
  else
    run="/bin/bash -c $(printf '%q' "$inner")"
    if [ "$now" = 1 ]; then remote_cmd="/usr/bin/lockf -t 0 -k $lock $run"
    else remote_cmd="/usr/bin/lockf -t 0 $lock true 2>/dev/null || echo 'Waiting for another check on $HOST to finish...'; /usr/bin/lockf -k $lock $run"; fi
  fi

  # A failed step's log path is on the host: its logs come back here, and the
  # path in the output is changed to match.
  local_logs="$(mktemp -d "${TMPDIR:-/tmp}/threadbear-check-remote.XXXXXX")"
  "${SSH[@]}" "$HOST" "$remote_cmd" 2>&1 | rewrite_logs "$remote_base/tmp-$id/threadbear-check." "$local_logs"
  code=${PIPESTATUS[0]}
  if [ "$now" = 1 ] && [ "$code" = 75 ]; then
    # Never started. Its copy stays for the next go (above).
    rmdir "$local_logs" 2>/dev/null
    if [ "$copy_secs" -ge "$stay_secs" ]; then echo "Another check took $HOST first; waiting for it there, as the copy took ${copy_secs}s."
    else echo "Another check took $HOST first; choosing again."; fi
    tries=$((tries + 1))
    continue
  fi
  break
done
rm -f "$files" "$changed"
if [ "$code" = 255 ]; then
  # Not "unreachable": that would make check.sh run it all again here.
  echo "Lost the connection to $HOST during the check." >&2
  code=1
fi

# The disk as the failure left it (keep_logs), or as it is now if that couldn't
# be written. -s: a full disk can leave the file empty.
fail_kb=""
if [ "$code" != 0 ]; then
  fail_kb="$("${SSH[@]}" "$HOST" "cd '$remote_base' && if [ -s 'kept-$id/free-kb' ]; then cat 'kept-$id/free-kb'; else $free_cmd; fi" 2>/dev/null)"
fi

# find, not a glob: the host's login shell may be zsh, which complains
# out loud when a glob matches nothing.
kept="$("${SSH[@]}" "$HOST" "find '$remote_base/kept-$id' -maxdepth 1 -name 'threadbear-check.*' 2>/dev/null | head -1")"
if [ -n "$kept" ]; then
  rsync -a -e "${SSH[*]}" "$HOST:$kept/" "$local_logs/" >/dev/null
fi
"${SSH[@]}" "$HOST" "rm -rf '$remote_base/kept-$id' '$remote_run'" 2>/dev/null
[ -n "$(ls -A "$local_logs")" ] || rmdir "$local_logs"

if [ -n "$SHOTS" ]; then
  mkdir -p "$SHOTS"
  rsync -a -e "${SSH[*]}" "$HOST:$remote_shots/" "$SHOTS/" >/dev/null && "${SSH[@]}" "$HOST" "rm -rf '$remote_shots'"
fi
# Last, so it's the line read: what a full disk breaks often looks nothing like
# one (a CodeSign error, 7 Nov).
if low_on_room "$fail_kb"; then
  echo "$HOST had only $FREE_GIB GiB free when this failed, and this check wants $MIN_FREE_GIB GiB, which may be why. Free some space there and run it again." >&2
fi
exit "$code"
