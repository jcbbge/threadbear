// Threadbear's own pages one click away and where its iPhone app stands with Apple. The panel asks
// Apple through Poddle's asc-status script (one team, one API key, so it's Mike's alone) and keeps
// the answer for 15 minutes. In anyone else's copy of this repo there's no script, so the panel,
// the Release button and the links to Mike's own accounts (App Store Connect, Sentry) don't show.
// Wayne saw the Sentry chip in his fork on 6 Nov and asked if he was meant to;
// test/unit/fork-view.test.ts now checks what a stranger's copy shows.

type Ctx = { sh: (command: string) => Promise<string> };
type Version = { version: string; state: string };

const APP_ID = "6827837354";
const CONNECT = `https://appstoreconnect.apple.com/apps/${APP_ID}/distribution`;
const KEEP_MS = 15 * 60 * 1000;

let cached: { at: number; value: Version[] } | undefined;
let pending: Promise<Version[]> | undefined;

function versions(sh: Ctx["sh"]): Promise<Version[]> {
  if (cached && Date.now() - cached.at < KEEP_MS) return Promise.resolve(cached.value);
  pending ??= sh(`node ~/dev/me/poddle/scripts/asc-status.mjs ${APP_ID}`)
    .then((out) => {
      const value = JSON.parse(out).versions as Version[];
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

// Mike's Mac, told by the script only he has. A file check rather than asking Apple, so the links
// stay when Apple's API is down.
const onMikesMac = async ({ sh }: Ctx) => {
  try {
    await sh("test -f ~/dev/me/poddle/scripts/asc-status.mjs");
    return true;
  } catch {
    return false;
  }
};

const needsMike = (state: string) => state === "PENDING_DEVELOPER_RELEASE" || state.endsWith("REJECTED");

const WORDS: Record<string, string> = {
  READY_FOR_DISTRIBUTION: "Live",
  PENDING_DEVELOPER_RELEASE: "Approved, waiting for you to release it",
  PENDING_APPLE_RELEASE: "Approved, on its way out",
  WAITING_FOR_REVIEW: "Waiting for review",
  IN_REVIEW: "In review",
  REJECTED: "Rejected",
  METADATA_REJECTED: "Rejected for its listing",
  DEVELOPER_REJECTED: "Pulled from review",
  PREPARE_FOR_SUBMISSION: "Not submitted yet",
};

export default {
  icon: "pawprint",
  actions: [
    { title: "Website", icon: "safari", url: "https://threadbear.mikecann.app/" },
    { title: "App Store Connect", icon: "app.badge", url: CONNECT, when: onMikesMac },
    { title: "Sentry", icon: "exclamationmark.triangle", url: "https://mikec.sentry.io/issues/?project=4512336956293120", when: onMikesMac },
    {
      title: "Release it",
      icon: "paperplane",
      note: "Shows once Apple has approved a version",
      prompt: "Apple has approved a version of Threadbear's iPhone app. Check where it stands with `node ~/dev/me/poddle/scripts/asc-status.mjs 6827837354`, release it through the App Store Connect API (POST /v1/appStoreVersionReleaseRequests), then send the next waiting build to review if there is one.",
      when: async ({ sh }: Ctx) => {
        try {
          return (await versions(sh))[0]?.state === "PENDING_DEVELOPER_RELEASE";
        } catch {
          return false;
        }
      },
    },
  ],
  panels: [
    {
      title: "App Store",
      icon: "app.badge",
      when: async ({ sh }: Ctx) => {
        try {
          return (await versions(sh)).length > 0;
        } catch {
          return false;
        }
      },
      badge: async ({ sh }: Ctx) => ((await versions(sh))[0] && needsMike((await versions(sh))[0].state) ? 1 : 0),
      items: async ({ sh }: Ctx) =>
        (await versions(sh)).slice(0, 3).map((v) => ({
          title: v.version,
          detail: WORDS[v.state] ?? v.state,
          url: CONNECT,
          icon: "app.badge",
          tone: needsMike(v.state) ? "attention" : v.state === "READY_FOR_DISTRIBUTION" ? "done" : undefined,
        })),
    },
  ],
};
