// devices.list, devices.pair and devices.revoke (docs/protocol.md,
// "Devices"): the Settings window's Phone & browser tab. Each is a call to
// the backend through the mirror's client (sync.ts), so pairing a phone or
// signing a browser in needs no Convex CLI. The token a pair issues goes
// back in the reply, inside the link the app draws or opens, and nowhere
// else: not the log, not a file, and no tb command prints one, since a
// thread's transcript can command agents.
import type { ConvexSync, Device, DeviceKind } from './sync.ts';
import { DEVICE_KINDS } from './sync.ts';
import { ErrorCode, RpcError } from './protocol.ts';

export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;

export type DeviceList = { devices: Device[]; site?: string; reason?: string };
export type Pairing = { device: Device; pairingLink?: string; signInLink?: string };

// The website is served from the deployment's .convex.site host
// (docs/website.md), or a self-hosted backend's sync.site; a local or odd
// URL has no site.
export { siteOf } from './convex-admin.ts';

// What the iPhone app scans (ios/ThreadbearKit Pairing.swift): the
// deployment and the token in a threadbear://pair link, and a
// `key=<runnerId>:<public key>` for each runner whose secret-box key the
// phone may seal to. The phone takes runner keys only from here, as they
// come straight from this Mac and not through the mirror.
export function pairingLink(url: string, token: string, keys: { runnerId: string; key: string }[] = []): string {
  const u = new URL('threadbear://pair');
  u.searchParams.set('url', url);
  u.searchParams.set('token', token);
  for (const k of keys) u.searchParams.append('key', `${k.runnerId}:${k.key}`);
  return u.toString();
}

// What the website takes (web/src/token.ts): the token in the #fragment,
// which a browser never sends to a server.
export function signInLink(site: string, token: string): string {
  return `${site}/#token=${token}`;
}

export function devicesMethods(sync: ConvexSync): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'devices.list': async (): Promise<DeviceList> => {
      const reason = sync.offReason();
      if (reason) return { devices: [], reason };
      const devices = await sync.listTokens().catch((e) => {
        throw new RpcError(ErrorCode.other, (e as Error).message);
      });
      const site = sync.site();
      return { devices, ...(site ? { site } : {}) };
    },
    'devices.pair': async (p): Promise<Pairing> => {
      const kind = p.kind;
      if (typeof kind !== 'string' || !(DEVICE_KINDS as readonly string[]).includes(kind)) throw bad(`kind must be one of ${DEVICE_KINDS.join(', ')}`);
      const name = p.name === undefined || p.name === null ? defaultName(kind as DeviceKind) : p.name;
      if (typeof name !== 'string' || !name.trim()) throw bad('name must be a non-empty string');
      let days = DEFAULT_DAYS;
      if (p.days !== undefined && p.days !== null) {
        if (typeof p.days !== 'number' || !Number.isFinite(p.days) || p.days < 1 || p.days > MAX_DAYS) throw bad(`days must be 1 to ${MAX_DAYS}`);
        days = Math.floor(p.days);
      }
      const url = sync.url();
      if (!url) throw new RpcError(ErrorCode.other, offMessage(sync));
      const site = sync.site();
      if (kind === 'browser' && !site) throw new RpcError(ErrorCode.other, `This runner doesn't know where the website is for ${url}. A self-hosted backend needs sync.site in runner.json (docs/self-hosting.md).`);
      let issued: { id: string; token: string; expiresAt: string };
      try {
        issued = await sync.issueToken({ kind: kind as DeviceKind, name: name.trim(), days });
      } catch (e) {
        throw new RpcError(ErrorCode.other, (e as Error).message);
      }
      const device: Device = { id: issued.id, kind: kind as DeviceKind, name: name.trim(), createdAt: new Date().toISOString(), expiresAt: issued.expiresAt, expired: false };
      return kind === 'phone' ? { device, pairingLink: pairingLink(url, issued.token, sync.pairingKeys()) } : { device, signInLink: signInLink(site!, issued.token) };
    },
    'devices.revoke': async (p): Promise<DeviceList> => {
      const id = p.deviceId;
      if (typeof id !== 'string' || !id) throw bad('deviceId must be a string');
      if (sync.offReason()) throw new RpcError(ErrorCode.other, offMessage(sync));
      let found: boolean;
      try {
        found = await sync.revokeToken(id);
      } catch (e) {
        throw new RpcError(ErrorCode.other, (e as Error).message);
      }
      if (!found) throw bad(`No phone or browser with id ${id}`);
      const devices = await sync.listTokens().catch(() => [] as Device[]);
      const site = sync.site();
      return { devices, ...(site ? { site } : {}) };
    },
  };
}

function defaultName(kind: DeviceKind): string {
  return kind === 'phone' ? 'iPhone' : 'Browser';
}

function offMessage(sync: ConvexSync): string {
  return `Your threads aren't mirrored to Convex (${sync.offReason() ?? 'sync is off'}), so there's nothing for a phone or browser to read. Run ./threadbear setup.`;
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}
