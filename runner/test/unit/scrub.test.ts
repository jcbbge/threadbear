// Known values and the withhold list (src/secret-values.ts, src/withhold.ts,
// src/scrub.ts). Every value here is made up on the spot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { KnownValues, looksRandom, parseEnvFile, REFRESH_MS, valuesOfSecretFile, valuesOfVariable } from '../../src/secret-values.ts';
import { Scrubber } from '../../src/scrub.ts';
import { HELD_BACK } from '../../src/redaction.ts';
import { withholdReason } from '../../src/withhold.ts';

// A variable, as the script has no types to check it against.
const SCRIPT: string = '../../scripts/scrub-stored.mjs';
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

test('.env parsing takes exports, comments and quoted values over several lines', () => {
  const parsed = parseEnvFile(['# a comment', 'PLAIN=abc # note', 'export QUOTED="two words"', "SINGLE='x'", 'MULTI="line one', 'line two"', 'bad line', 'AFTER=1'].join('\n'));
  assert.deepEqual(parsed, [
    { name: 'PLAIN', value: 'abc' },
    { name: 'QUOTED', value: 'two words' },
    { name: 'SINGLE', value: 'x' },
    { name: 'MULTI', value: 'line one\nline two' },
    { name: 'AFTER', value: '1' },
  ]);
});

test('which variables are masked', () => {
  const value = rand();
  assert.deepEqual(valuesOfVariable('STRIPE_SECRET', value), [value]);
  assert.deepEqual(valuesOfVariable('WEBHOOK', value), [value], 'random-looking, whatever it is called');
  assert.deepEqual(valuesOfVariable('API_KEY', 'short'), [], 'too short to mask safely');
  assert.deepEqual(valuesOfVariable('VITE_PUBLIC_KEY', value), [], 'ships in a client bundle');
  assert.deepEqual(valuesOfVariable('CONVEX_URL', 'https://opulent-moose-249.ap-southeast-2.convex.cloud'), []);
  assert.deepEqual(valuesOfVariable('CONVEX_DEPLOYMENT', 'dev:earnest-puffin-640'), []);
  assert.deepEqual(valuesOfVariable('DEBUG_LEVEL', 'verbose-but-ordinary-words'), []);
  // Fixed: a random one now and then doesn't look random enough, and this flaked.
  const withPassword = 'postgres://me:xK9fQ2mP7vL4@db.example.com/x';
  assert.ok(valuesOfVariable('DATABASE_URL', withPassword).includes(withPassword), 'an address with a password in it');
  assert.equal(looksRandom('/Users/sam/dev/some/long/path/9'), false);
});

test('a multi-line key is masked whole and a line at a time', () => {
  const lines = [rand(48), rand(48), rand(48)];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
  const found = valuesOfVariable('AUTH_PRIVATE_KEY', pem);
  for (const l of lines) assert.ok(found.includes(l));
  assert.ok(!found.some((v) => v === '-----BEGIN PRIVATE KEY-----'), 'the marker lines are not secrets');
  const escaped = valuesOfVariable('AUTH_PRIVATE_KEY', pem.replaceAll('\n', '\\n'));
  for (const l of lines) assert.ok(escaped.includes(l));
});

test('secret files: env, JSON and plain ones', () => {
  const a = rand();
  assert.deepEqual(valuesOfSecretFile('/s/convex-deploy.env', `CONVEX_DEPLOY_KEY="prod:x|${a}"\n`), [`prod:x|${a}`]);
  assert.deepEqual(valuesOfSecretFile('/s/panel.json', JSON.stringify({ adminKey: a, deployment: 'dev:calm-cat-1' })), [a]);
  assert.deepEqual(valuesOfSecretFile('/s/convex-key', `${a}\n`), [a]);
  assert.deepEqual(valuesOfSecretFile('/s/x', 'no\n'), []);
});

function files(dir: string, map: Record<string, string>): void {
  for (const [name, text] of Object.entries(map)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

// Rewrites a file and moves its time on a second. Linux keeps file times to
// a kernel tick, so a same-size rewrite straight after the first write has
// the same size and time, and looks unchanged (hive, Ubuntu 22.04, 5 Nov).
function rewrite(file: string, text: string): void {
  const before = fs.statSync(file).mtime;
  fs.writeFileSync(file, text);
  const after = new Date(before.getTime() + 1000);
  fs.utimesSync(file, after, after);
}

test('known values come from secrets/ and thread folders, and mask however they turn up', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const secrets = path.join(root, 'secrets');
  const repo = path.join(home, 'dev', 'app');
  const runnerKey = rand();
  const asked = rand(6);
  const token = rand();
  const envValue = rand();
  const subValue = rand();
  const exampleValue = rand();
  files(secrets, { 'convex-key': runnerKey, 'asked/0123': asked, 'runners/abc.token': token, 'runners/abc.host': 'cloud.example.ts.net\n', 'asked/0123.askpass': `#!/bin/sh\nexec /bin/cat '/x/0123'\n` });
  files(repo, { '.git/HEAD': 'x', '.env.local': `WEBHOOK_SECRET=${envValue}\nCONVEX_URL=https://calm-cat-1.convex.cloud\n`, '.env.example': `WEBHOOK_SECRET=${exampleValue}\n`, 'web/.env': `RESEND_TOKEN=${subValue}\n` });
  const known = new KnownValues({ secretsDir: secrets, env: { MY_API_KEY: 'a'.repeat(4) + 'bcdefgh1234567', PATH: '/usr/bin' }, home });
  known.noteFolder(repo);
  await known.settled();
  const masked = known.mask(`a ${runnerKey} b ${asked} c ${token} d ${envValue} e ${subValue} f ${exampleValue} g aaaabcdefgh1234567`);
  for (const v of [runnerKey, asked, token, envValue, subValue, 'aaaabcdefgh1234567']) assert.ok(!masked.includes(v));
  assert.ok(masked.includes(exampleValue), 'examples hold placeholders');
  assert.equal(known.mask('see https://calm-cat-1.convex.cloud and cloud.example.ts.net'), 'see https://calm-cat-1.convex.cloud and cloud.example.ts.net');
  assert.ok(!known.mask(`line ${runnerKey.slice(0, 4)}`).includes('[REDACTED]'), 'part of a value is not the value');
});

test('an answer to ask_secret stays masked once its file is swept; a deleted .env value goes', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const secrets = path.join(root, 'secrets');
  const repo = path.join(home, 'app');
  const asked = rand(10);
  const envValue = rand();
  files(secrets, { 'asked/0123': asked });
  files(repo, { '.git/HEAD': 'x', '.env': `A_SECRET=${envValue}\n` });
  let now = 1000;
  const known = new KnownValues({ secretsDir: secrets, env: {}, home, now: () => now });
  known.noteFolder(repo);
  await known.settled();
  assert.ok(!known.mask(asked).includes(asked));
  assert.ok(!known.mask(envValue).includes(envValue));
  fs.rmSync(path.join(secrets, 'asked', '0123'));
  fs.rmSync(path.join(repo, '.env'));
  now += REFRESH_MS + 1;
  await known.refresh();
  assert.ok(!known.mask(asked).includes(asked), 'asked stays');
  assert.ok(known.mask(envValue).includes(envValue), 'a deleted file takes its values');
});

test('looks only at what changed, and not again inside the refresh time', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const repo = path.join(home, 'app');
  const first = rand();
  const second = rand();
  files(repo, { '.git/HEAD': 'x', '.env': `A_SECRET=${first}\n` });
  let now = 1000;
  const known = new KnownValues({ env: {}, home, now: () => now });
  known.noteFolder(repo);
  await known.settled();
  rewrite(path.join(repo, '.env'), `A_SECRET=${second}\n`);
  known.refreshIfDue();
  await known.settled();
  assert.ok(known.mask(second).includes(second), 'too soon to look again');
  now += REFRESH_MS + 1;
  known.refreshIfDue();
  await known.settled();
  assert.ok(!known.mask(second).includes(second));
});

test('a home folder and external volumes are not looked through', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const value = rand();
  files(home, { '.env': `A_SECRET=${value}\n` });
  const known = new KnownValues({ env: {}, home });
  known.noteFolder(home);
  known.noteFolder('/Volumes/CannMedia/thing');
  known.noteFolder('relative/path');
  await known.settled();
  assert.equal(known.count, 0);
});

test('a value with regex characters masks literally', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const repo = path.join(home, 'app');
  const value = `a+b(c)[d]${rand(8)}$|^.*`;
  files(repo, { '.git/HEAD': 'x', '.env': `A_SECRET='${value}'\n` });
  const known = new KnownValues({ env: {}, home });
  known.noteFolder(repo);
  await known.settled();
  assert.equal(known.mask(`x ${value} y`), 'x [REDACTED] y');
  assert.equal(known.mask('nothing like it'), 'nothing like it');
});

test('the Scrubber runs known values, then the rules, and counts what it changed', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const secrets = path.join(root, 'secrets');
  const value = rand();
  files(secrets, { 'convex-key': value });
  const s = new Scrubber({ secretsDir: secrets, env: {}, home });
  await s.known.settled();
  const shape = `sk-${'a1'.repeat(24)}`;
  const out = s.doc({ title: `${value} and ${shape}`, key: value });
  assert.equal(out.title, '[REDACTED] and [REDACTED]');
  assert.equal(out.key, value, 'the mutation has to carry the runner key');
  assert.equal(s.status().changed, 1);
  assert.equal(s.status().failed, 0);
  assert.equal(s.status().knownValues, 1);
  assert.ok(!JSON.stringify(s.status()).includes(value));
});

test('text whose check throws is held back and counted, with no words in the status', () => {
  const s = new Scrubber({ env: {}, home: tmpDir() });
  s.known.mask = () => {
    throw new Error('it said something private');
  };
  assert.equal(s.doc({ title: 'a title that gets checked' }).title, HELD_BACK);
  assert.equal(s.safeText('a title that gets checked'), HELD_BACK);
  assert.equal(s.status().failed, 2);
  assert.ok(!JSON.stringify(s.status()).includes('private'));
});

const cmd = (command: string) => withholdReason({ kind: 'command', name: 'Bash', input: { command } });
const read = (file_path: string) => withholdReason({ kind: 'read', name: 'Read', input: { file_path } });

test('commands whose output is withheld', () => {
  for (const c of [
    'npx convex env list',
    'npx convex env list --prod | sed -E "s/=.*//" | sort',
    'npx convex env get OPENAI_API_KEY',
    'vercel env pull',
    'netlify env:list',
    'printenv',
    'printenv | grep KEY',
    'env',
    'env | sort',
    'ls && env | grep KEY',
    'sudo env',
    'set | grep TOKEN',
    'export -p',
    'declare -x',
    'heroku config',
    'security find-generic-password -s foo -w',
    'security find-internet-password -a me -w',
    'security dump-keychain',
    'gh auth token',
    'gh auth status --show-token',
    'op read op://vault/item/field',
    'aws configure get aws_secret_access_key',
    'aws secretsmanager get-secret-value --secret-id x',
    'gcloud auth print-access-token',
    'kubectl get secret db -o yaml',
    'vault kv get secret/x',
    'ssh-keygen -y -f key',
    'openssl genrsa 2048',
    'tb phone-token',
    'npx convex run tokens:issue \'{"name":"x"}\'',
    'npx convex deployment token create x',
    'git credential fill',
    'cat .env',
    'cat .env.local',
    'grep KEY .env.production',
    "sed 's/=.*//' .env",
    'cat ~/.ssh/id_ed25519',
    'cat AuthKey_ABC.p8',
    'base64 < key.pem',
    'cat "$HOME/Library/Application Support/Threadbear/secrets/convex-key"',
    'cat ~/.aws/credentials',
    'head -1 ~/.npmrc',
    'cat ~/.netrc',
    'cat service-account.json',
    'jq . credentials.json',
    'python3 -c "print(open(\'.env\').read())"',
    'cd web && cat .env.local',
  ]) {
    assert.ok(cmd(c), `should withhold: ${c}`);
  }
});

test('ordinary commands are not withheld', () => {
  for (const c of [
    'npm test',
    'env FOO=1 npm test',
    'env -i PATH=/usr/bin node x.js',
    'NODE_ENV=production npm run build',
    'git status',
    'git log --oneline -5',
    'cat README.md',
    'cat .env.example',
    'cp .env.sample .env.sample.bak',
    'ls -la src',
    'grep -rn "token" src/auth.ts',
    'cat src/secrets.ts',
    'cat docs/environment.md',
    'node --env-file=x.js',
    'rg dotenv package.json',
    'cat ~/.ssh/id_ed25519.pub',
    'cat ~/.ssh/known_hosts',
    'cat ~/.ssh/config',
    'tsc --noEmit -p .',
    'settings set theme dark',
    'gh pr view 12',
    'op --version',
    'kubectl get pods',
    'npx convex deploy',
    'npx convex data messages --limit 5',
  ]) {
    assert.equal(cmd(c), undefined, `should go up: ${c}`);
  }
});

test('files whose contents are withheld', () => {
  for (const f of ['/app/.env', '/app/.env.local', '/app/web/.env.production', '/k/AuthKey_ABC.p8', '/k/server.pem', '/k/tls.key', '~/.ssh/id_rsa', '/h/.npmrc', '/h/.aws/credentials', '/h/.aws/config', '/h/.kube/config', '/h/.docker/config.json', '/h/.config/gh/hosts.yml', '/x/credentials.json', '/x/service-account-prod.json', '/x/client_secret_123.json', '/Threadbear/secrets/convex-key']) {
    assert.ok(read(f), `should withhold: ${f}`);
  }
  for (const f of ['/app/src/main.ts', '/app/.env.example', '/app/.env.template', '/app/README.md', '/h/.ssh/id_rsa.pub', '/app/src/secrets.ts', '/app/docs/keys.md', '/app/keyboard.ts', '/app/credentials.ts', '/a/screenshot.png']) {
    assert.equal(read(f), undefined, `should go up: ${f}`);
  }
  assert.ok(withholdReason({ kind: 'search', name: 'Grep', input: { pattern: 'KEY', path: '/app/.env' } }));
  assert.ok(withholdReason({ kind: 'search', name: 'Grep', input: { pattern: 'KEY', glob: '.env*' } }));
  assert.equal(withholdReason({ kind: 'search', name: 'Grep', input: { pattern: 'KEY', path: '/app/src' } }), undefined);
  assert.equal(withholdReason({ kind: 'web', name: 'WebFetch', input: { url: 'https://example.com/a.pem' } }), undefined);
  assert.equal(withholdReason({}), undefined);
});

test('scrub-stored goes through every table a page at a time and says only ids and counts', async () => {
  const { scrubStored, TABLES } = await import(SCRIPT);
  const calls: { table: string; cursor: string | null; apply: boolean; limit: number }[] = [];
  const said: string[] = [];
  const totals = await scrubStored({
    key: 'k',
    apply: false,
    batch: 2,
    say: (l: string) => said.push(l),
    post: async (fn: string, a: { table: string; cursor: string | null; apply: boolean; limit: number }) => {
      assert.equal(fn, 'sync:scrubStoredBatch');
      calls.push(a);
      if (a.table === 'messages' && a.cursor === null) return { scanned: 2, changed: ['row1'], cursor: 'c1', done: false, rulesVersion: 1 };
      return { scanned: 1, changed: [], cursor: 'end', done: true, rulesVersion: 1 };
    },
  });
  assert.equal(totals.messages.scanned, 3);
  assert.equal(totals.messages.changed, 1);
  assert.deepEqual(totals.messages.ids, ['row1']);
  assert.equal(calls.filter((c) => c.table === 'messages').length, 2);
  assert.equal(calls[1]!.cursor, 'c1');
  assert.ok(calls.every((c) => c.apply === false), 'dry run unless asked');
  assert.deepEqual(Object.keys(totals), TABLES);
  assert.equal(said.length, TABLES.length);
});

test('the script knows every table the backend does', async () => {
  const { TABLES } = await import(SCRIPT);
  const src = fs.readFileSync(new URL('../../../convex/sync.ts', import.meta.url), 'utf8');
  const declared = src.match(/const SCRUB_TABLES = \[([^\]]+)\]/)![1]!.match(/'(\w+)'/g)!.map((s) => s.slice(1, -1));
  assert.deepEqual(TABLES, declared);
});

test('tb status says plainly what protects this runner', async () => {
  const { formatSecrets } = await import('../../src/tb-dev.ts');
  const base = { rulesVersion: 1, knownValues: 3, changed: 0, failed: 0 };
  const counts = { since: 'x', checkedText: 40, checkedImages: 10, flaggedText: 2, flaggedImages: 1, errors: 0, rulesAndModel: 0, rulesOnly: 0 };
  const none = formatSecrets(base, undefined, 0).join('\n');
  assert.match(none, /3 known values/);
  assert.match(none, /Not a guarantee: rotate any key that leaks/);
  assert.match(none, /relies on the rules and the withhold list/);
  assert.match(formatSecrets(base, { state: 'starting', since: '', checkedText: 7, checkedImages: 0, flaggedText: 1, flaggedImages: 0, errors: 0, rulesAndModel: 0, rulesOnly: 0 }, 0).join('\n'), /waiting for its first run.*1 of 7/);
  assert.match(formatSecrets(base, undefined, 0, { bodies: 1, bytes: 1, withheld: 0, unsent: 0, pending: 0 })[0]!, /Tool output goes up too/);
  assert.match(formatSecrets({ ...base, backendChecks: false }, undefined, 0)[0]!, /too old to check again/);
  assert.match(formatSecrets({ ...base, backendChecks: true }, undefined, 0)[0]!, /the backend checks again/);
  assert.match(formatSecrets(base, { state: 'unsupported', reason: 'x', ...counts }, 0)[1]!, /none on this machine/);
  assert.match(formatSecrets(base, { state: 'unavailable', reason: 'Apple Intelligence is off', ...counts }, 0)[1]!, /Apple Intelligence is off/);
  const on = formatSecrets(base, { state: 'on', file: '/d/secret-check.json', ...counts }, 0)[1]!;
  assert.match(on, /changes nothing that uploads/);
  assert.match(on, /2 of 40 tool outputs and 1 of 10 pictures/);
  assert.match(formatSecrets({ ...base, failed: 2, lastFailure: 'RangeError' }, undefined, 0)[1]!, /failed on 2 strings, held back/);
});

test('.env: a quoted value with a comment after it, and the line after that', () => {
  const parsed = parseEnvFile(['API_KEY="value-one" # production', "OTHER='value # two'   # note", 'THIRD="a \\" quote"', 'MULTI="one', 'two" # done', 'LAST=x'].join('\n'));
  assert.deepEqual(parsed, [
    { name: 'API_KEY', value: 'value-one' },
    { name: 'OTHER', value: 'value # two' },
    { name: 'THIRD', value: 'a \\" quote' },
    { name: 'MULTI', value: 'one\ntwo' },
    { name: 'LAST', value: 'x' },
  ]);
});

async function knownWith(env: string): Promise<KnownValues> {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const repo = path.join(home, 'app');
  files(repo, { '.git/HEAD': 'x', '.env': env });
  const known = new KnownValues({ env: {}, home });
  known.noteFolder(repo);
  await known.settled();
  return known;
}

test('a known value with a quote in it is masked as JSON text writes it too', async () => {
  const value = `opaq"ue${rand(10)}`;
  const known = await knownWith(`A_SECRET='${value}'\n`);
  const text = JSON.stringify({ out: value });
  assert.ok(!known.mask(text).includes(value.slice(5)));
});

test('a multi-line value with short lines is masked as JSON text writes it', async () => {
  const value = `${rand(6)}\n${rand(6)}`;
  const known = await knownWith(`A_SECRET="${value}"\n`);
  assert.ok(!known.mask(JSON.stringify({ out: value })).includes(value.split('\n')[1]!));
});

test('a known value cut off at the end of a text is masked, whatever cut it', async () => {
  const value = rand(30);
  const known = await knownWith(`A_SECRET=${value}\n`);
  const start = value.slice(0, 20);
  assert.equal(known.mask(`title ${start}`), 'title [REDACTED]');
  assert.equal(known.mask(`line ${start}…`), 'line [REDACTED]…');
  assert.equal(known.mask(`msg ${start}\n\n[cut: the rest is on the Mac]`), 'msg [REDACTED]\n\n[cut: the rest is on the Mac]');
  assert.equal(known.mask(`msg ${start}\n\n[cut: the rest is on the Mac]\n\n[2 pictures]`), 'msg [REDACTED]\n\n[cut: the rest is on the Mac]\n\n[2 pictures]');
  assert.equal(known.mask(`${start} and then more words`), `${start} and then more words`, 'only where a cut can be');
  assert.equal(known.mask(`short ${value.slice(0, 8)}`), `short ${value.slice(0, 8)}`);
});

test('a short known value only goes as a whole word', async () => {
  const known = new KnownValues({ env: {}, home: tmpDir(), folders: false });
  known.add('question');
  assert.equal(known.mask('the question is whether'), 'the [REDACTED] is whether');
  assert.equal(known.mask('two questions here'), 'two questions here');
});

test('an answer to ask_secret is masked the moment it is given', async () => {
  const dir = tmpDir();
  const { SecretStore } = await import('../../src/secrets.ts');
  const store = new SecretStore(dir);
  const known = new KnownValues({ secretsDir: dir, env: {}, home: tmpDir(), folders: false });
  await known.refresh();
  const value = `opaque!${rand(8)}`;
  assert.equal(known.mask(`it is ${value} ok`), `it is ${value} ok`);
  store.onWritten = (v) => known.add(v);
  store.write(value);
  assert.equal(known.mask(`it is ${value} ok`), 'it is [REDACTED] ok');
});

test('a folder looked at once is not looked at again, and lookSoon brings a look forward', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const repo = path.join(home, 'old');
  const live = path.join(home, 'live');
  const first = rand();
  const second = rand();
  files(repo, { '.git/HEAD': 'x', '.env': `A_SECRET=${first}\n` });
  files(live, { '.git/HEAD': 'x', '.env': `A_SECRET=${first}\n` });
  let now = 1000;
  const known = new KnownValues({ env: {}, home, now: () => now });
  known.noteFolder(repo, true);
  known.noteFolder(live);
  await known.settled();
  assert.ok(!known.mask(first).includes(first));
  rewrite(path.join(repo, '.env'), `A_SECRET=${second}\n`);
  now += REFRESH_MS + 1;
  await known.refresh();
  assert.ok(known.mask(second).includes(second), 'once means once');
  rewrite(path.join(live, '.env'), `A_SECRET=${second}\n`);
  known.lookSoon(live);
  await known.settled();
  assert.ok(!known.mask(second).includes(second));
});

test('commands that read one variable are withheld too', () => {
  for (const c of [
    `node -p 'process.env["API_KEY"]'`,
    `node -e 'console.log(process.env.API_KEY)'`,
    `python3 -c "import os; print(os.environ['API_KEY'])"`,
    `python -c "import os; print(os.getenv('API_KEY'))"`,
    'aws --profile prod secretsmanager get-secret-value --secret-id x',
    'echo $OPENAI_API_KEY',
    'echo "${GITHUB_TOKEN}"',
    'printf "%s" "$DB_PASSWORD"',
  ]) {
    assert.ok(cmd(c), `should withhold: ${c}`);
  }
  for (const c of ['grep -rn process.env src', 'echo $HOME', 'echo "$PATH"', 'node -e "console.log(1)"', 'python3 -c "print(1)"', 'aws s3 ls']) {
    assert.equal(cmd(c), undefined, `should go up: ${c}`);
  }
});

test('settled waits for a folder that turned up during a look', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const a = path.join(home, 'a');
  const b = path.join(home, 'b');
  const value = rand();
  files(a, { '.git/HEAD': 'x', '.env': `A_SECRET=${rand()}\n` });
  files(b, { '.git/HEAD': 'x', '.env': `B_SECRET=${value}\n` });
  const known = new KnownValues({ env: {}, home });
  known.noteFolder(a);
  known.noteFolder(b);
  await known.settled();
  assert.ok(!known.mask(value).includes(value));
});

test('more folders than any limit are all looked at', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const known = new KnownValues({ env: {}, home });
  const value = rand();
  files(path.join(home, 'first'), { '.git/HEAD': 'x', '.env': `A_SECRET=${value}\n` });
  known.noteFolder(path.join(home, 'first'), true);
  for (let i = 0; i < 600; i++) known.noteFolder(path.join(home, `none-${i}`), true);
  await known.settled();
  assert.ok(!known.mask(value).includes(value));
});

test('a cut-off value: as JSON writes it, and a very long one', async () => {
  const quoted = `opaq"ue${rand(16)}`;
  const long = rand(600);
  const known = await knownWith(`A_SECRET='${quoted}'\nB_SECRET=${long}\n`);
  const escaped = JSON.stringify(quoted).slice(1, -1);
  assert.equal(known.mask(`x ${escaped.slice(0, -2)}`), 'x [REDACTED]');
  assert.equal(known.mask(`x ${long.slice(0, -1)}`), 'x [REDACTED]');
});

test('whitespace closed up in a preview still masks a known passphrase', async () => {
  const known = new KnownValues({ env: {}, home: tmpDir(), folders: false });
  known.add('alpha12  beta34gamma56');
  assert.equal(known.mask('said alpha12 beta34gamma56 ok'), 'said [REDACTED] ok');
});

test('masking cut-offs costs about the same however many values there are', () => {
  const known = new KnownValues({ env: {}, home: tmpDir(), folders: false });
  for (let i = 0; i < 5000; i++) known.add(rand(24));
  const text = 'ordinary words in a row '.repeat(14);
  known.mask(text); // compiles
  const started = performance.now();
  for (let i = 0; i < 200; i++) known.mask(text);
  assert.ok(performance.now() - started < 10_000);
});

test('a very long command is still judged by its start', () => {
  assert.ok(cmd(`cat .env; ${'x '.repeat(100_000)}`));
  const started = performance.now();
  cmd('security '.repeat(200_000));
  assert.ok(performance.now() - started < 10_000);
});

test('settled says when it ran out of time, and a stuck folder is given up on', async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const repo = path.join(home, 'app');
  files(repo, { '.git/HEAD': 'x' });
  const known = new KnownValues({ env: {}, home });
  assert.equal(await known.settled(), true, 'nothing to wait for');
  known.noteFolder(repo);
  assert.equal(await known.settled(0), false);
  assert.equal(await known.settled(), true);
  assert.equal(known.unread, 0);
});

test('a known passphrase cut off in a preview, with its whitespace closed up', () => {
  const known = new KnownValues({ env: {}, home: tmpDir(), folders: false });
  known.add('alpha12  beta34gamma56');
  assert.equal(known.mask('said alpha12 beta34gamma…'), 'said [REDACTED]…');
});
