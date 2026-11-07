/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as devices from "../devices.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as phone from "../phone.js";
import type * as projectHeads from "../projectHeads.js";
import type * as projectNotes from "../projectNotes.js";
import type * as push from "../push.js";
import type * as pushHealth from "../pushHealth.js";
import type * as pushTargets from "../pushTargets.js";
import type * as pushText from "../pushText.js";
import type * as redaction from "../redaction.js";
import type * as relay from "../relay.js";
import type * as runnerAccess from "../runnerAccess.js";
import type * as share from "../share.js";
import type * as sync from "../sync.js";
import type * as tokens from "../tokens.js";
import type * as version from "../version.js";
import type * as wakes from "../wakes.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  devices: typeof devices;
  http: typeof http;
  lib: typeof lib;
  phone: typeof phone;
  projectHeads: typeof projectHeads;
  projectNotes: typeof projectNotes;
  push: typeof push;
  pushHealth: typeof pushHealth;
  pushTargets: typeof pushTargets;
  pushText: typeof pushText;
  redaction: typeof redaction;
  relay: typeof relay;
  runnerAccess: typeof runnerAccess;
  share: typeof share;
  sync: typeof sync;
  tokens: typeof tokens;
  version: typeof version;
  wakes: typeof wakes;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
