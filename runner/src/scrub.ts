// The runner's end of secret scrubbing (docs/convex-backend.md, "Secret
// scrubbing"): everything that goes to Convex goes through this first, known
// values before the shape rules, as a known value may be one no rule would
// recognise. The runner's own copy of a thread is never changed.
import { redactSecrets, scrubDoc, SCRUB_RULES_VERSION } from './redaction.ts';
import { KnownValues } from './secret-values.ts';
import type { Logger } from './log.ts';

export type ScrubStatus = {
  rulesVersion: number;
  knownValues: number;
  // Thread folders that didn't answer when last looked at.
  foldersUnread?: number;
  // Strings the rules or a known value changed since this runner started.
  changed: number;
  // Strings held back because the check itself failed.
  failed: number;
  lastFailure?: string;
};

export class Scrubber {
  readonly known: KnownValues;
  private log?: Logger;
  private changed = 0;
  private failed = 0;
  private lastFailure?: string;
  private lastLogged?: string;

  // `folders: false` leaves thread folders alone: the shape rules and whatever
  // else it's told, for a sync with no scrubber of its own, which is a test's.
  constructor(opts: { secretsDir?: string; env?: NodeJS.ProcessEnv; home?: string; log?: Logger; now?: () => number; folders?: boolean } = {}) {
    this.log = opts.log;
    this.known = new KnownValues({
      secretsDir: opts.secretsDir,
      env: opts.env,
      home: opts.home,
      now: opts.now,
      folders: opts.folders,
      onError: (what) => this.log?.debug('secret check could not read a file', { what }),
    });
    if (opts.secretsDir) void this.known.refresh();
  }

  // One string. May throw: `doc` catches it, and so must any other caller
  // that means to carry on.
  text = (text: string): string => {
    const out = redactSecrets(this.known.mask(text)).text;
    if (out !== text) this.changed++;
    return out;
  };

  doc<T>(value: T): T {
    return scrubDoc(value, this.text, (e) => this.noteFailure(e));
  }

  // For text about to be cut short, which is the one place a value could be
  // split in two and each half missed. A failed check gives back nothing to send.
  safeText = (text: string): string => scrubDoc(text, this.text, (e) => this.noteFailure(e));

  // For what must not go at all if its check fails: counted, then thrown on.
  strict = (text: string): string => {
    try {
      return this.text(text);
    } catch (e) {
      this.noteFailure(e);
      throw e;
    }
  };

  private noteFailure(e: unknown): void {
    this.failed++;
    // Its name only: an error's message can quote what it was looking at.
    this.lastFailure = (e as Error)?.name ?? 'Error';
    if (this.lastFailure !== this.lastLogged) {
      this.lastLogged = this.lastFailure;
      this.log?.warn('secret check failed: held that text back from Convex', { error: this.lastFailure });
    }
  }

  status(): ScrubStatus {
    return {
      rulesVersion: SCRUB_RULES_VERSION,
      knownValues: this.known.count,
      ...(this.known.unread ? { foldersUnread: this.known.unread } : {}),
      changed: this.changed,
      failed: this.failed,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }
}
