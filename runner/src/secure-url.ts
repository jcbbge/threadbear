// Which URLs may carry a credential: the runner key in every sync post,
// the Connectors gateway's Authorization header. https anywhere; plain
// http only to this machine (localhost, 127.0.0.0/8, [::1]), for a local
// Convex backend or a test's fake gateway. Daybreak (7 Nov) found sync and
// connector URLs took any http:// URL, so a typo or a tampered runner.json
// sent long-lived keys and thread text in the clear (an http:// Convex
// cloud URL answers 301 to https, after the key has gone).
//
// Checked on the parsed URL, never the raw string: WHATWG parsing
// lowercases the scheme and host and turns 127.1, 0x7f.0.0.1 and
// 2130706433 into 127.0.0.1, so http://127.0.0.1.evil.com and
// http://localhost.evil.com stay what they are (someone else's host).

// The reason a URL can't carry a credential, or undefined when it can.
// Never repeats the URL's userinfo, so it's safe to log.
export function credentialUrlProblem(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "isn't a URL";
  }
  // http://127.0.0.1@evil.com is evil.com; and a name and password in the
  // URL itself would go in logs and status lines, so none at all.
  if (u.username || u.password) return `has a name or password in it (${u.protocol}//…@${u.host}); take them out`;
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname) ? undefined : `is plain http to ${u.host}, so its keys would go in the clear; use https (plain http is only for this Mac: localhost, 127.0.0.1, [::1])`;
  return `is ${u.protocol}, not https`;
}

// `hostname` as URL gives it: lowercased, IPv4 normalised to four decimal
// parts, IPv6 in brackets and compressed ([0:0:0:0:0:0:0:1] is [::1]).
// IPv4-mapped [::ffff:127.0.0.1] (URL writes [::ffff:7f00:1]) is left out:
// nothing local needs it. So is "localhost." with its trailing dot.
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return Boolean(m && m.slice(1).every((p) => Number(p) <= 255));
}
