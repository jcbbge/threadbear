#!/bin/zsh -l
# Takes out everything a self-hosted Threadbear install put on this Mac
# (docs/on-your-mac.md, docs/self-hosting.md), so a test Mac is clean again
# for the next run of record-self-hosted-install.sh. It deletes your threads
# and their Convex mirror: only for a Mac you installed on to test.
#
#   zsh scripts/remove-self-hosted-install.sh --yes [--keep-prefs FILE]
#
# --keep-prefs restores the app's preferences from a `defaults export` taken
# before the install, rather than deleting them.
set -u
[[ "${1:-}" == --yes ]] || { echo "This deletes Threadbear and all its data from this Mac. Run it with --yes." >&2; exit 1; }
PREFS=""
[[ "${2:-}" == --keep-prefs ]] && PREFS="${3:?--keep-prefs needs a file}"
export PATH=/Applications/Docker.app/Contents/Resources/bin:$PATH
DATA="$HOME/Library/Application Support/Threadbear"

# By its bundle id: by name this could quit another thread's debug app.
osascript -e 'tell application id "com.mikerosoft.threadbear" to quit' 2>/dev/null
if [[ -x "$HOME/threadbear/runner/scripts/install-runner.sh" ]]; then
  bash "$HOME/threadbear/runner/scripts/install-runner.sh" --uninstall --force || true
fi
launchctl bootout "gui/$(id -u)/com.mikerosoft.threadbear.runner" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.mikerosoft.threadbear.runner.plist"

docker rm -f threadbear-convex threadbear-convex-dashboard 2>/dev/null
docker volume rm threadbear-convex-data 2>/dev/null
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
for p in 3210 3211 6791; do "$TS" serve --https=$p off 2>/dev/null; done

rm -rf "$HOME/Applications/Threadbear.app" "$HOME/Applications/Threadbear Runner.app" \
  "$DATA" "$HOME/threadbear" "$HOME/ThreadbearThreads" "$HOME/install-threadbear" "$HOME/.local/bin/threadbear" \
  "$HOME/Library/Caches/Threadbear" "$HOME/Library/Logs/Threadbear" \
  "$HOME/Library/Logs/threadbear-runner.log" "$HOME/Library/Logs/threadbear-update.log"
if [[ -n "$PREFS" ]]; then
  defaults import com.mikerosoft.threadbear "$PREFS"
else
  defaults delete com.mikerosoft.threadbear 2>/dev/null
fi
echo "Threadbear is off this Mac."
