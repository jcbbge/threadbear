// A timeout that counts only the time this process was awake to act.
//
// The auth handshake's timers (client.ts, rpc.ts) are plain deadlines, and
// a stalled process misses them unfairly: on a loaded Mac (a load of 60+
// from other threads' Swift builds, 6 Nov) node can sit unscheduled for
// seconds with the other side's reply already in the socket. When it wakes,
// the event loop runs due timers before it reads the socket, so a plain
// setTimeout fires "too late" even though the answer was there. Here a
// stall doesn't count: the clock ticks in small steps and a tick counts
// for at most one step however late it came, so a process starved bit by
// bit (not just in one long stall) gets its time too. When the time is up
// the callback still waits a turn of the loop (setImmediate runs after the
// socket reads) in case the answer arrived during the last stall.
export type AwakeTimer = { clear(): void };

export function awakeTimeout(ms: number, fn: () => void, now: () => number = () => performance.now()): AwakeTimer {
  const step = Math.max(10, Math.min(100, ms / 4));
  let awake = 0;
  let last = now();
  let done = false;
  let immediate: NodeJS.Immediate | undefined;
  const tick = setInterval(() => {
    const t = now();
    // A tick later than `step` means the process wasn't running for the
    // rest of the gap, so that part doesn't count.
    awake += Math.min(t - last, step);
    last = t;
    if (awake < ms) return;
    clearInterval(tick);
    immediate = setImmediate(() => {
      if (!done) {
        done = true;
        fn();
      }
    });
  }, step);
  tick.unref();
  return {
    clear() {
      done = true;
      clearInterval(tick);
      if (immediate) clearImmediate(immediate);
    },
  };
}
