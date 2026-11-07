# The Ask server

Ask on the iPhone (the Action button, or the waveform in the inbox) sends a
spoken question to a server of your own and reads out its answer. The
server is what knows things about you: Mike's is Agent Archive, which
answers from every agent conversation he's had and from the web. Agent
Archive isn't public yet; Mike will be talking about it soon and releasing
it then.

Until then, any server that speaks the small protocol below works with
Ask. It's two HTTP endpoints. The phone's side is in
`ios/Threadbear/QuickAskCore` (`AskAPI.swift`, `ServerAnswerStream.swift`,
`Sources.swift`) if you want to check a detail.

## Settings

The phone's Settings > Ask takes the server's address and a token. The
address is `https://` (or `http://`) and a host, with or without a path in
front of `/api`; a missing scheme is taken as `https://`. The phone has to
be able to reach it: Mike's runs on a Mac on his tailnet, so his phone uses
Tailscale.

The token goes in an `Authorization: Bearer <token>` header. Agent Archive's
tokens look like `aa_<16 hex>_<secret>`, but the phone sends whatever you
give it.

A server can also hand both over in a link, usually as a QR code:
`threadbear://quickask?url=<address>&token=<token>`, both URL-encoded.
A link's address has to be `https://` (or have no scheme), since opening
it sends the token and every later question there; an `http://` one is
refused and nothing changes. The phone asks before using any link, the
first one included: "Use Quick Ask on <host>?", saying whether it sets up
Ask, switches it from another host, or gives the same host a new token.
Nothing changes until you say yes.

## GET /api/quick/ping

Sent as you start talking, and again if the last one was more than 25
seconds ago, so the connection is open by the time the question is ready.
No token, and the answer's body is ignored: any quick response will do.

## POST /api/quick/ask

Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`,
`Accept: application/x-ndjson`.

```json
{
  "question": "When did I last renew the car rego?",
  "history": [{ "question": "...", "answer": "..." }],
  "timezone": "Australia/Perth",
  "clientTime": "2026-11-02T14:06:00+08:00"
}
```

- `question`: what was said, trimmed.
- `history`: the earlier questions and answers in this conversation, oldest
  first, at most three. Left out when there are none.
- `timezone`: an IANA name. `clientTime`: the phone's time, ISO 8601 with
  its offset.

Send the response headers within about 6 seconds. If none have come by 7,
the phone sends the question once more on a new connection. The answer can
come back in either of two forms.

### Plain text

Any content type other than `application/x-ndjson`: the body, streamed as
UTF-8, is the answer. The phone shows and speaks it as it arrives.

Sources go in an optional `X-Quick-Sources` header: base64url (no padding)
of a UTF-8 JSON array of `{ "title", "url", "threadId"?, "date"? }`, with
`date` as `yyyy-MM-dd`. The first three are shown under the answer.

### NDJSON

`Content-Type: application/x-ndjson`, one JSON object per line:

| Line | What the phone does |
|---|---|
| `{"type":"text","text":"..."}` | Adds the text to the answer. |
| `{"type":"stage","stage":"web"}` | Shows "Searching the web…" until the next text. |
| `{"type":"stage","stage":"deep"}` | Shows "Digging deeper…"; the text after it is the deeper part of the answer. |
| `{"type":"sources","sources":[...]}` | Shows sources: `{ "kind": "web" or "archive", "title", "url", "threadId"?, "date"? }`. A web source's `url` must be an http(s) page. |
| `{"type":"ping"}` | Nothing: a keepalive. |
| `{"type":"done","deep":"..."}` | The answer is complete. `deep` is a finish reason, any string. |

The stream must end with a `done` line, newline included, or the phone says
the answer was cut off. Lines it doesn't know are skipped, so a server can
send more than this.

Timing: until the first `stage` line, the phone waits at most 30 seconds
between bytes. After one, the whole answer has 75 seconds, with at most 15
between lines, so send `ping` lines while a slow step runs.

### Errors

Answer with a status and `{"error":"..."}`. The phone shows its own words
for the status, with your message after them in brackets:

- 401 or 403: the token wasn't accepted (it points to Settings).
- 429: too many questions, try again in a minute.
- Any other 4xx: the server didn't accept the question.
- 5xx: the server had a problem.

An optional `Server-Timing` header goes into the phone's timing log, which
helps when working out where a slow answer spent its time.

## After the answer

The phone keeps the question and answer as a thread on the Mac, through
your own Convex backend; follow-ups go to that thread's agent like any
other reply. The Ask server isn't involved after the answer.
