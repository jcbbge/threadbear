// Two real HTTP servers on 127.0.0.1 for the "never follow a redirect with
// a credential" tests: `url` answers every request 307 to `trap`, and
// `trap` writes down what reached it. Real fetch follows a 307 by sending
// the same method, body and headers on, so anything in `hits` is what a
// runner key or a gateway token would have handed to another host.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type TrapHit = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

export async function redirectTrap(): Promise<{ url: string; trap: string; hits: TrapHit[]; close(): Promise<void> }> {
  const hits: TrapHit[] = [];
  const trapServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"success","value":"stolen"}');
    });
  });
  const trap = await listen(trapServer);
  const redirector = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `${trap}/stolen${req.url ?? ''}` }).end();
  });
  const url = await listen(redirector);
  return {
    url,
    trap,
    hits,
    close: () => Promise.all([trapServer, redirector].map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined),
  };
}

// A stand-in for fetch where `from` answers 307 to plain http on another
// host, as real fetch would treat it: redirect 'error' throws, 'manual'
// hands back the 307, and the default ('follow') sends the same request on
// to `to`, which is written down in `leaked`.
export function downgradeFetch(from: string, to = 'http://evil.example/stolen'): { fetch: typeof fetch; inits: RequestInit[]; leaked: { url: string; init: RequestInit }[] } {
  const inits: RequestInit[] = [];
  const leaked: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    inits.push(init);
    if (!String(url).startsWith(from)) throw new Error(`unexpected fetch of ${String(url)}`);
    if (init.redirect === 'error') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    if (init.redirect === 'manual') return new Response(null, { status: 307, headers: { location: to } });
    leaked.push({ url: to, init });
    return new Response('{"status":"success","value":"stolen","result":{"content":[{"type":"text","text":"stolen"}]}}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: f, inits, leaked };
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}
