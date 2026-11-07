#!/usr/bin/env node
// Releases an approved version to the App Store, the API's version of App Store Connect's
// "Release This Version" button. Versions go in with a manual release (appstore-submit.mjs), so
// an approved one sits in Pending Developer Release until this runs.
//
//   node ios/scripts/appstore-release.mjs <version>             says where the version is; changes nothing
//   node ios/scripts/appstore-release.mjs <version> --release   releases it if it's approved
//
// Prints the version's state on the last line, so a scheduled check can tell "still in review"
// from "released" from "rejected". Exits 0 unless the API call fails.
import { api, appId, get } from "./appstore-lib.mjs";

const [versionString] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const release = process.argv.includes("--release");
if (!versionString) {
  console.error("Usage: node ios/scripts/appstore-release.mjs <version> [--release]");
  process.exit(1);
}
const APP_ID = await appId();
const versions = await get(`/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${versionString}&limit=1`);
const version = versions.data[0];
if (!version) throw new Error(`no iOS version ${versionString} in App Store Connect`);
const state = version.attributes.appVersionState ?? version.attributes.appStoreState;

if (state === "PENDING_DEVELOPER_RELEASE" && release) {
  await api("POST", "/v1/appStoreVersionReleaseRequests", {
    data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } },
  });
  const after = (await get(`/v1/appStoreVersions/${version.id}`)).data.attributes;
  console.log(`Released ${versionString}: ${after.appVersionState ?? after.appStoreState}`);
} else if (state === "PENDING_DEVELOPER_RELEASE") {
  console.log(`${versionString} is approved and waiting to be released (--release releases it): ${state}`);
} else {
  console.log(`${versionString}: ${state}`);
}
