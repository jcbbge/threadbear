import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';

// A dialog left on the screen of a Mac nobody's looking at (docs/protocol.md,
// "A dialog on a Mac's screen").
//
// macOS asks about a protected folder or a removable drive in the name of
// Threadbear Runner, for anything under it, an agent's `find ~/Downloads` or
// a tool that goes looking on a drive. Once a prompt is up it stays up, even
// after whatever asked has gone (tried on Tinker Desk, 1 Nov 2026). And it
// holds up more than its asker: on 31 Oct 2026 a prompt waiting on Bruce's
// locked screen stopped Sammy Cam getting at its external drive from 22:00 to
// 06:43, with its own permission long granted, and nothing said so.
//
// frozen-cli.ts sees this only from inside a turn, and only if the CLI itself
// is the one stuck. So this looks at the screen: the runner tells the prompt
// apart from everything else by the window being UserNotificationCenter's,
// which reads the same on a locked screen and needs no permission.
//
// It's on every Mac rather than only ones thought to be unattended: there's no
// telling that from here (a Mac can have the app and nobody at it), and five
// minutes is long enough that someone at the Mac has already answered.

// osascript costs about 0.2 seconds and 30 MB, gone straight after, so a look
// is cheap but not free on Bruce's 8 GB.
export const LOOK_MS = 2 * 60_000;
export const TELL_AFTER_MS = 5 * 60_000;

export interface ScreenProbe {
  // How many dialogs are up, or undefined if it can't tell.
  dialogs(): Promise<number | undefined>;
  fullDiskAccess(): boolean | undefined;
  hasApp(): boolean;
}

type Host = {
  // Says it in the given thread, or in a new one if that's gone or put away,
  // in Needs you either way. Returns the thread's id.
  noticeOnMac(threadId: string | undefined, title: string, text: string): string;
  // Says it's over. With archive, nothing else is left to do: it leaves
  // Needs you and the thread is put away, unless someone has written in it,
  // as then it's a conversation and not just a notice. Without, it stays in
  // Needs you.
  noticeOverOnMac(threadId: string, text: string, archive: boolean): void;
};

type Deps = { host: Host; clock: Clock; log: Logger; machine: string; stateFile: string; probe?: ScreenProbe };

type State = { dialogsSince?: string; dialogsTold?: boolean; threadId?: string; accessTold?: boolean };

export type MacScreenStatus = { fullDiskAccess?: boolean; dialogs: number; dialogsSince?: string };

export class MacScreen {
  private deps: Deps;
  private probe: ScreenProbe;
  private timer?: TimerHandle;
  private state: State;
  private dialogs = 0;
  private access?: boolean;

  constructor(deps: Deps) {
    this.deps = deps;
    this.probe = deps.probe ?? realProbe();
    // On disk, as a release can restart this runner every few minutes.
    this.state = readJsonSync<State>(deps.stateFile) ?? {};
  }

  start(): void {
    this.arm(0);
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  status(): MacScreenStatus {
    return {
      ...(this.access === undefined ? {} : { fullDiskAccess: this.access }),
      dialogs: this.dialogs,
      ...(this.dialogs && this.state.dialogsSince ? { dialogsSince: this.state.dialogsSince } : {}),
    };
  }

  private arm(ms: number): void {
    this.timer = this.deps.clock.setTimeout(() => {
      void this.look().finally(() => this.timer && this.arm(LOOK_MS));
    }, ms);
  }

  async look(): Promise<void> {
    try {
      this.lookAtAccess();
      this.lookAtDialogs(await this.probe.dialogs());
    } catch (e) {
      this.deps.log.warn('could not look at the screen', { error: (e as Error).message });
    }
  }

  private lookAtAccess(): void {
    const { machine, log } = this.deps;
    this.access = this.probe.fullDiskAccess();
    if (this.access === true && this.state.accessTold) {
      // Granted since: say so, or the thread goes on saying it's missing
      // (ganttbookM5, 5 Nov 2026). It archives unless a dialog it told of is
      // still up, which lookAtDialogs closes out when it goes.
      if (this.state.threadId) {
        try {
          this.deps.host.noticeOverOnMac(this.state.threadId, accessGrantedText(machine), !this.state.dialogsTold);
        } catch {
          // Deleted since: nobody to tell.
        }
      }
      delete this.state.accessTold;
      this.save();
      return;
    }
    if (this.access !== false || this.state.accessTold || this.probe.hasApp()) return;
    log.warn('no Full Disk Access on a Mac without the app');
    this.tell(accessText(machine));
    this.state.accessTold = true;
    this.save();
  }

  private lookAtDialogs(count: number | undefined): void {
    const { clock, machine, log, host } = this.deps;
    // Can't look: nothing's known to have changed.
    if (count === undefined) return;
    this.dialogs = count;
    if (!count) {
      if (!this.state.dialogsSince) return;
      if (this.state.dialogsTold && this.state.threadId) {
        try {
          // Mike keeps his inbox at zero, and nothing's left to do here. The
          // Full Disk Access note shares this thread and is still to do while
          // the access isn't known to be there, so that keeps it (a look
          // that couldn't tell isn't a grant).
          host.noticeOverOnMac(this.state.threadId, goneText(machine), !(this.state.accessTold && this.access !== true));
        } catch {
          // Deleted since: nobody to tell.
        }
      }
      delete this.state.dialogsSince;
      delete this.state.dialogsTold;
      this.save();
      return;
    }
    const now = clock.now();
    if (!this.state.dialogsSince) {
      this.state.dialogsSince = new Date(now).toISOString();
      this.save();
    }
    if (this.state.dialogsTold || now - Date.parse(this.state.dialogsSince) < TELL_AFTER_MS) return;
    log.warn('a dialog is waiting on the screen', { count, since: this.state.dialogsSince });
    this.tell(dialogText(machine, Math.round((now - Date.parse(this.state.dialogsSince)) / 60_000)));
    this.state.dialogsTold = true;
    this.save();
  }

  private tell(text: string): void {
    this.state.threadId = this.deps.host.noticeOnMac(this.state.threadId, noticeTitle(this.deps.machine), text);
  }

  private save(): void {
    try {
      atomicWriteFileSync(this.deps.stateFile, JSON.stringify(this.state));
    } catch (e) {
      this.deps.log.warn('could not save what the screen check knows', { error: (e as Error).message });
    }
  }
}

export function noticeTitle(machine: string): string {
  return `${machine} needs someone at its screen`;
}

export function dialogText(machine: string, minutes: number): string {
  return `A macOS dialog has been waiting on ${machine}'s screen for ${minutes} minutes. If it's a privacy prompt, everything else that needs the same folder or drive can be held up until someone answers it, and it stays up even if what asked has gone. Open Screen Sharing to ${machine} and answer it. To stop these prompts on that Mac, give Threadbear Runner Full Disk Access in System Settings > Privacy & Security.`;
}

export function goneText(machine: string): string {
  return `The dialog on ${machine}'s screen has gone.`;
}

export function accessText(machine: string): string {
  return `Threadbear Runner doesn't have Full Disk Access on ${machine}, and nobody's likely to be at its screen. When an agent there touches Desktop, Documents, Downloads or a removable drive, macOS waits for someone to answer a prompt, and that can hold up other apps using the same drive. In System Settings > Privacy & Security > Full Disk Access on ${machine}, turn on Threadbear Runner. Agents there can then read everything your account can.`;
}

export function accessGrantedText(machine: string): string {
  return `Threadbear Runner has Full Disk Access on ${machine} now, so folder prompts won't hold up its agents.`;
}

// Whether a file opens. Undefined when it isn't there, so can't say.
export function canOpen(file: string): boolean | undefined {
  try {
    fs.closeSync(fs.openSync(file, 'r'));
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? false : undefined;
  }
}

export function parseDialogCount(text: string): number | undefined {
  const m = /^\s*(\d+)\s*$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

// The 4-by-2 windows UserNotificationCenter makes for a dialog queued behind
// another aren't dialogs yet, so the width leaves them out. Its last line is
// what osascript prints.
const COUNT_DIALOGS = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))) || [];
all.filter((w) => w.kCGWindowOwnerName === 'UserNotificationCenter' && w.kCGWindowLayer > 0 && w.kCGWindowBounds.Width >= 100).length;
`;

export function realProbe(home: string = os.homedir()): ScreenProbe {
  return {
    dialogs() {
      return new Promise((resolve) => {
        execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', COUNT_DIALOGS], { encoding: 'utf8', timeout: 20_000 }, (err, stdout) => {
          resolve(err ? undefined : parseDialogCount(stdout));
        });
      });
    },
    // The usual way to ask: macOS's own permissions database only opens with
    // Full Disk Access, and refuses at once otherwise, with no prompt (it's
    // the one file here that can't start the trouble it's checking for).
    // It's opened and closed, never read.
    fullDiskAccess() {
      return canOpen(path.join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'));
    },
    hasApp() {
      return ['/Applications', path.join(home, 'Applications')].some((dir) => fs.existsSync(path.join(dir, 'Threadbear.app')));
    },
  };
}
