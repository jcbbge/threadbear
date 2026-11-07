#!/bin/bash
# Checks the runner and the app on the pinned Node 24: one line per step,
# what failed and the end of the log for each step that failed, and a
# nonzero exit if any did.
#
#   ./check.sh [--quick | --app] [--all] [--e2e] [--shots DIR] [--local]
#
# With a check host set (THREADBEAR_CHECK_HOST, or "checkHost" in the
# runner's runner.json, an ssh host such as "tinker-desk"; or "checkHosts",
# a list of them, the first free one that can run it taking each run, which
# wins over checkHost so a copy older than the list still finds one), the checks run
# there instead (scripts/check-remote.sh), so test suites and the app's test
# windows stay off this one. If it can't be reached they run
# here. --e2e always runs here, as it needs this Mac's claude login.
#   --local       run here even with a check host set (narrow it down too:
#                 one test file, or swift test --filter)
#
#   (no options)  runner typecheck, unit tests and deploy tests, then the
#                 app's swift build and swift test, and BearDock's tests
#   --quick       runner typecheck and unit tests only (about a minute)
#   --app         the app's swift build and swift test only, for a change
#                 that doesn't touch runner/
#   --all         don't skip the dock and deploy tests (below)
#
# When up to 8 of the runner's unit test files fail, those run again on
# their own, one at a time, and a pass then counts: the step's line lists
# the tests that needed it (runner_unit_tests, below, says why).
#
# The deploy tests (a few minutes) only run when something they cover
# changed from main: runner/scripts/, launch.mjs, the launcher or the tests
# themselves. BearDock's tests only run when dock/ changed (the app's own
# build and tests cover how it uses it). The iPhone app's ThreadbearKit
# tests run with any of the options when ios/ changed, --quick included, so
# `tb land` runs them (MicTapTests guards a crash the phone hit twice). On
# main itself, with nothing changed, everything runs.
#
# A Swift step that prints nothing for 10 minutes, or runs for an hour, is
# killed and fails, saying which test was running and where it was stuck.
#
# How long the app takes depends on its build cache: under a minute when
# app/.build is warm, 5 to 10 minutes in a folder that has never built
# (a new worktree), as SwiftPM's cache only works where it was made. Run
# it in the background rather than waiting on it.
#   --e2e         also the runner's end-to-end tests: the real claude CLI on
#                 claude-haiku-5-5 and login claude-main (TB_E2E_ACCOUNT), then Codex on
#                 gpt-6-luna at low effort and a Codex install into a temp
#                 folder, all in temp folders (several minutes, a few cents;
#                 TB_E2E_SKIP_CODEX=1 leaves the Codex ones out)
#   --shots DIR   also save the app's design screenshots to DIR
#                 (app/Tools/screenshots.sh; look at them afterwards)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${THREADBEAR_NODE:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
QUICK=0
APP_ONLY=0
ALL=0
E2E=0
SHOTS=""
LOCAL=0
ARGS=("$@")

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --app) APP_ONLY=1 ;;
    --all) ALL=1 ;;
    --e2e) E2E=1 ;;
    --local) LOCAL=1 ;;
    --shots)
      [ $# -ge 2 ] || { echo "--shots needs a folder" >&2; exit 2; }
      case "$2" in /*) SHOTS="$2" ;; *) SHOTS="$PWD/$2" ;; esac
      shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$QUICK" = 1 ] && [ "$APP_ONLY" = 1 ]; then
  echo "--quick is the runner's checks and --app the app's; pick one (or neither for both)." >&2
  exit 2
fi

# The check host: THREADBEAR_CHECK_HOST (set and empty means none), or
# runner.json's checkHost. Read before the THREADBEAR_* names go below.
if [ "$LOCAL" = 0 ] && [ "$E2E" = 0 ]; then
  if [ -n "${THREADBEAR_CHECK_HOST+set}" ]; then
    CHECK_HOST="$THREADBEAR_CHECK_HOST"
  else
    RUNNER_JSON="${THREADBEAR_HOME:-$HOME/Library/Application Support/Threadbear}/runner.json"
    CHECK_HOST="$( [ -x "$NODE" ] && [ -f "$RUNNER_JSON" ] && "$NODE" -e '
      try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const h = Array.isArray(j.checkHosts) ? j.checkHosts : j.checkHost; const l = (Array.isArray(h) ? h : [h]).filter((x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(x)); if (l.length) console.log(l.join(",")) } catch {}' "$RUNNER_JSON")"
  fi
  if [ -n "$CHECK_HOST" ]; then
    "$ROOT/scripts/check-remote.sh" "$CHECK_HOST" ${ARGS[@]+"${ARGS[@]}"}
    code=$?
    [ "$code" = 255 ] || exit "$code"
    echo "So the checks run on this Mac instead, at low priority."
    exec taskpolicy -b "$0" --local ${ARGS[@]+"${ARGS[@]}"}
  fi
elif [ "$E2E" = 1 ] && [ "$LOCAL" = 0 ]; then
  echo "--e2e runs on this Mac, which has the claude login it needs."
fi

if [ ! -x "$NODE" ]; then
  echo "No Node binary at $NODE. Set THREADBEAR_NODE to a Node 24 binary." >&2
  exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"
export THREADBEAR_NODE="$NODE"
# Inside a Threadbear thread these name the live runner and the thread.
# Every test makes its own temp data dir; none may find the real one.
unset THREADBEAR_HOME THREADBEAR_DATA_DIR THREADBEAR_PORT THREADBEAR_URL THREADBEAR_LOG \
  THREADBEAR_THREAD_ID THREADBEAR_RUNNER_VERSION THREADBEAR_RUNNER_HOME
# And their old names, which the runner and tb would otherwise take for these.
for v in $(compgen -e | grep '^THREADBARE_' || true); do unset "$v"; done
# No runner a check starts may install or update a CLI.
export THREADBEAR_CLI_UPDATES=off
# Nor write to the real Convex project (the sync e2e points its own runner
# at a local deployment with THREADBEAR_SYNC_URL).
export THREADBEAR_SYNC=off

# What this checkout changes from main: committed since they parted, plus
# anything uncommitted or untracked. Empty on main itself.
if [ -n "${THREADBEAR_CHECK_CHANGED_FILE:-}" ]; then
  # On a check host: worked out on the Mac that sent the copy, which has
  # no .git (scripts/check-remote.sh).
  CHANGED="$(cat "$THREADBEAR_CHECK_CHANGED_FILE")"
else
CHANGED="$( {
  base="$(git -C "$ROOT" merge-base HEAD main 2>/dev/null)" && git -C "$ROOT" diff --name-only "$base"
  git -C "$ROOT" ls-files --others --exclude-standard
} 2>/dev/null | sort -u)"
fi

# needed <regex>: whether a step whose inputs match it should run.
needed() {
  [ "$ALL" = 1 ] || [ -z "$CHANGED" ] || printf '%s\n' "$CHANGED" | grep -qE "$1|^check\.sh$"
}

skip() {
  printf 'skip  %-20s (%s; --all runs it)\n' "$1" "$2"
}

TMP_ROOT="${TMPDIR:-/tmp}"
LOGS="$(mktemp -d "${TMP_ROOT%/}/threadbear-check.XXXXXX")"
FAILED=""

# step <name> <dir> <command...>: runs it with its output in a log file.
step() {
  local name="$1" dir="$2"
  shift 2
  local log="$LOGS/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-').log"
  local start=$SECONDS
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    printf 'ok    %-20s %4ss\n' "$name" "$((SECONDS - start))"
  else
    printf 'FAIL  %-20s %4ss  %s\n' "$name" "$((SECONDS - start))" "$log"
    FAILED="$FAILED$name|$log
"
  fi
}

# The Swift steps run through this, as one frozen test holds the check host
# and so every thread's landing (scripts/limit-step.mjs says how it tells, and
# app/Tests/ModalGuard is the quicker catch for a modal). Each test prints when
# it starts, so 10 minutes of nothing is plenty even on a loaded machine, and a
# build from cold takes 5 to 10 minutes in all but keeps printing.
# NSUnbufferedIO is what makes xctest print as it goes when it isn't on a
# terminal: without it a frozen run's log doesn't say which test.
export NSUnbufferedIO=YES
LIMITED=("$NODE" "$ROOT/scripts/limit-step.mjs"
  --silence "${THREADBEAR_CHECK_SILENCE_SECS:-600}" --total "${THREADBEAR_CHECK_TOTAL_SECS:-3600}" --)

# The runner's unit tests, as `npm test` runs them (runner/package.json),
# plus a reporter that writes the files with a failure. Plenty of them
# start real processes with real timeouts, and on a loaded machine those
# fail with nothing wrong: six did at once, taking 13 to 145 s, while other
# threads built the app on the M5 (6 Nov). So when a few files failed, just
# those run again, one file at a time; passing then counts, but the step
# says which tests needed it, so one that keeps turning up gets fixed. A
# test that fails on its own as well still fails the step.
RERUN_MAX_FILES=8
runner_unit_tests() {
  local name="runner unit tests" dir="$ROOT/runner"
  local log="$LOGS/runner-unit-tests.log" list="$LOGS/runner-unit-tests.failed"
  local start=$SECONDS
  local run=(node --test --test-timeout=300000 --test-force-exit --test-reporter=spec)
  if (cd "$dir" && "${run[@]}" --test-reporter-destination=stdout \
      --test-reporter=./test/helpers/failed-files-reporter.mjs --test-reporter-destination="$list" \
      "test/unit/**/*.test.ts") >"$log" 2>&1; then
    printf 'ok    %-20s %4ss\n' "$name" "$((SECONDS - start))"
    return
  fi
  local files=() f
  [ -f "$list" ] && while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done <"$list"
  if [ "${#files[@]}" -ge 1 ] && [ "${#files[@]}" -le "$RERUN_MAX_FILES" ]; then
    local relog="$LOGS/runner-unit-tests-again.log"
    if (cd "$dir" && "${run[@]}" --test-concurrency=1 "${files[@]}") >"$relog" 2>&1; then
      printf 'ok    %-20s %4ss  (passed on a second run of the files that failed:)\n' "$name" "$((SECONDS - start))"
      # The tests that failed the first time: the spec reporter's ✖ lines,
      # once each (its summary at the end repeats them).
      sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | grep -E '^[[:space:]]*✖ ' | grep -v '✖ failing tests:' | sed -E 's/^[[:space:]]*/        /' | sort -u | head -n 12
      return
    fi
    printf 'FAIL  %-20s %4ss  %s (failed again on its own; the whole run: %s)\n' "$name" "$((SECONDS - start))" "$relog" "$log"
    FAILED="$FAILED$name|$relog
"
    return
  fi
  printf 'FAIL  %-20s %4ss  %s\n' "$name" "$((SECONDS - start))" "$log"
  FAILED="$FAILED$name|$log
"
}

if [ "$APP_ONLY" = 0 ]; then
  if [ ! -d "$ROOT/runner/node_modules" ]; then
    step "runner packages" "$ROOT/runner" npm ci --no-audit --no-fund
  fi
  step "runner typecheck" "$ROOT/runner" npm run typecheck
  # The app's Node tools (the tour's end-to-end test, the mock runner)
  # aren't typechecked or run here: at least they have to parse. A quote
  # slip in tour-e2e.mjs went unnoticed until it was next run (2 Nov).
  step "app tools parse" "$ROOT/app/Tools" bash -c 'for f in *.mjs mock-runner/*.mjs; do node --check "$f" || exit 1; done'
  # The Convex functions (convex/), against the generated types in git.
  if [ ! -d "$ROOT/node_modules" ]; then
    step "convex packages" "$ROOT" npm ci --no-audit --no-fund
  fi
  step "convex typecheck" "$ROOT" npm run convex:typecheck
  step "web typecheck" "$ROOT" npm run web:typecheck
  step "web tests" "$ROOT" npm run web:test
  runner_unit_tests
  if [ "$QUICK" = 0 ]; then
    if needed '^runner/(scripts/|launch\.mjs$|launcher/|test/deploy/)'; then
      step "runner deploy tests" "$ROOT/runner" bash test/deploy/run.sh
    else
      skip "runner deploy tests" "nothing they cover changed"
    fi
  fi
fi
if [ "$QUICK" = 0 ]; then
  # The app's MockRunnerTests run the real WebSocket client (and the
  # runner restart) against the mock, and skip without its packages: in a
  # fresh checkout or worktree they used to skip while this said ok.
  if [ ! -d "$ROOT/app/Tools/mock-runner/node_modules" ]; then
    step "mock runner packages" "$ROOT/app/Tools/mock-runner" npm ci --no-audit --no-fund
  fi
  step "app build" "$ROOT/app" "${LIMITED[@]}" swift build --disable-keychain
  step "app tests" "$ROOT/app" env THREADBEAR_REQUIRE_MOCK=1 "${LIMITED[@]}" swift test --disable-keychain
  # BearDock, the window's docking panels: its layout tests.
  if needed '^dock/'; then
    step "dock tests" "$ROOT/dock" "${LIMITED[@]}" swift test --disable-keychain
  else
    skip "dock tests" "nothing in dock/ changed"
  fi
fi
# The iPhone app's logic and source checks (ios/ThreadbearKit), on the Mac.
# The app itself only builds with Xcode; ios/scripts/sim-shots.sh does that.
if needed '^ios/'; then
  step "iphone kit tests" "$ROOT/ios/ThreadbearKit" "${LIMITED[@]}" swift test --disable-keychain
else
  skip "iphone kit tests" "nothing in ios/ changed"
fi
if [ "$E2E" = 1 ]; then
  # Claude's first, then Codex's (codex*.e2e.test.ts: the conversation
  # tests and the install test), which TB_E2E_SKIP_CODEX=1 leaves out.
  E2E_RUN=(node --test --test-reporter=spec --test-concurrency=1 --test-timeout=600000)
  CLAUDE_E2E=()
  CODEX_E2E=()
  for f in "$ROOT"/runner/test/e2e/*.test.ts; do
    case "$(basename "$f")" in codex*) CODEX_E2E+=("$f") ;; *) CLAUDE_E2E+=("$f") ;; esac
  done
  step "runner e2e" "$ROOT/runner" "${E2E_RUN[@]}" "${CLAUDE_E2E[@]}"
  if [ "${TB_E2E_SKIP_CODEX:-0}" = 1 ]; then
    echo "skip  codex e2e            (TB_E2E_SKIP_CODEX=1)"
  elif [ "${#CODEX_E2E[@]}" -gt 0 ]; then
    step "codex e2e" "$ROOT/runner" "${E2E_RUN[@]}" "${CODEX_E2E[@]}"
  fi
fi
[ -z "$SHOTS" ] || step "app screenshots" "$ROOT/app" bash Tools/screenshots.sh "$SHOTS"

if [ -n "$FAILED" ]; then
  printf '%s' "$FAILED" | while IFS='|' read -r name log; do
    # The failures themselves first: swift test runs the core tests before
    # the app's, so a failing core test is hundreds of lines above the end
    # of its log (XCTest's "error:" and "failed (", Swift Testing's ✘, the
    # node test runner's ✖ and "not ok", tsc's "error TS").
    # (swift colours its output even into a file, so that comes off first.)
    failures="$(sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | grep -nE ': error[: ]|error TS[0-9]|'"'"' failed \(|^not ok|✖|✘' | head -n 20)"
    if [ -n "$failures" ]; then
      echo
      echo "--- $name: what failed (line: text) in $log"
      printf '%s\n' "$failures"
    fi
    echo
    echo "--- $name: end of $log"
    tail -n 30 "$log"
  done
  echo
  echo "Logs kept in $LOGS; rm -rf it when you're done."
  exit 1
fi
rm -rf "$LOGS"
[ -z "$SHOTS" ] || echo "Screenshots are in $SHOTS."
