// node --test web/src/draft.test.ts
// ```slack, ```email and ```draft blocks: text for Mike to send elsewhere,
// shown line for line with a Copy button. The Mac's and the phone's
// DraftBlockTests check the same cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bareLinks, draftFrom, fenceClosed, maxFormattedLine, maxSource, draftHTML, draftLabel, draftLines, draftPlainText, slackSpans, type Draft } from './draft.ts';

const joined = (draft: Draft) => draftLines(draft).map((l) => l.spans.map((s) => s.text).join(''));

test('only the draft fences count', () => {
  assert.equal(draftFrom('slack', 'hi\n')?.kind, 'slack');
  assert.equal(draftFrom('Email subject=x', 'hi')?.kind, 'email');
  assert.equal(draftFrom('draft', 'hi')?.kind, 'draft');
  assert.equal(draftFrom('slackbot', 'hi'), undefined);
  assert.equal(draftFrom(undefined, 'hi'), undefined);
  assert.equal(draftFrom('slack', ' \n\n'), undefined);
  assert.equal(draftFrom('slack', 'a\r\nb\n\n')?.source, 'a\nb');
  assert.equal(draftLabel('slack'), 'Slack draft');
  assert.equal(draftLabel('email'), 'Email draft');
  assert.equal(draftLabel('draft'), 'Draft');
});

test('every line stays a line', () => {
  const draft: Draft = { kind: 'draft', source: '*Threadbear, 6 Nov*\n• one\n• two\n\nThanks' };
  assert.deepEqual(joined(draft), ['*Threadbear, 6 Nov*', '• one', '• two', '', 'Thanks']);
  // Only a Slack draft reads Slack's formatting.
  assert.ok(!draftLines(draft)[0]!.spans[0]!.bold);
  assert.equal(draftPlainText(draft), draft.source);
});

test('slack formatting', () => {
  assert.deepEqual(slackSpans('*Shipped* _today_: ~old~ `tb land` and *_both_*'), [
    { text: 'Shipped', bold: true },
    { text: ' ' },
    { text: 'today', italic: true },
    { text: ': ' },
    { text: 'old', strike: true },
    { text: ' ' },
    { text: 'tb land', code: true },
    { text: ' and ' },
    { text: 'both', bold: true, italic: true },
  ]);
});

test('markers inside words and lone ones stay as written', () => {
  for (const text of ['2*3*4', 'snake_case_name', 'a * b * c', '*open only', 'price: $5_000_']) {
    assert.deepEqual(slackSpans(text), [{ text }], text);
  }
  // Markdown's **bold** is Slack's *bold* with a star either side, which is
  // how Slack shows it too.
  assert.deepEqual(slackSpans('**x**'), [{ text: '*' }, { text: 'x', bold: true }, { text: '*' }]);
});

test('links and mentions', () => {
  const spans = slackSpans('See <https://example.com/a?b=1|the docs>, <https://x.dev> or <mailto:m@x.dev>; cc <@U123> in <#C9|general> <!here> & 1 < 2 &amp; <b>');
  assert.deepEqual(
    spans.flatMap((s) => (s.link ? [s.link] : [])),
    ['https://example.com/a?b=1', 'https://x.dev', 'mailto:m@x.dev'],
  );
  assert.equal(spans.map((s) => s.text).join(''), 'See the docs, https://x.dev or m@x.dev; cc @U123 in #general @here & 1 < 2 & <b>');
  // Other schemes aren't links.
  assert.equal(slackSpans('<javascript:alert(1)|x>')[0]?.link, undefined);
  assert.equal(slackSpans('<javascript:alert(1)|x>').map((s) => s.text).join(''), '<javascript:alert(1)|x>');
});

test('copy keeps slack markers but spells out links', () => {
  const draft: Draft = { kind: 'slack', source: '*Done* <https://x.dev/pr/1|the PR>\n<https://x.dev>\n> quoted &lt;tag&gt;' };
  assert.equal(draftPlainText(draft), '*Done* the PR (https://x.dev/pr/1)\nhttps://x.dev\n> quoted <tag>');
  assert.equal(
    draftHTML(draft),
    '<meta charset="utf-8"><div><b>Done</b> <a href="https://x.dev/pr/1">the PR</a><br><a href="https://x.dev">https://x.dev</a><blockquote>quoted &lt;tag&gt;</blockquote></div>',
  );
  assert.ok(draftLines(draft)[2]!.quote);
});

test('html is escaped', () => {
  const draft: Draft = { kind: 'email', source: 'Hi <script>alert("x")</script> & bye' };
  assert.equal(draftHTML(draft), '<meta charset="utf-8"><div>Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; bye</div>');
});

test('bare addresses in an email or plain draft are links when drawn', () => {
  assert.deepEqual(bareLinks('See https://x.dev/pr/1. Or http://a.b/c?d=1), ftp://no'), [
    { text: 'See ' },
    { text: 'https://x.dev/pr/1', link: 'https://x.dev/pr/1' },
    { text: '. Or ' },
    { text: 'http://a.b/c?d=1', link: 'http://a.b/c?d=1' },
    { text: '), ftp://no' },
  ]);
  assert.deepEqual(bareLinks('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(bareLinks(''), []);
  // Copy keeps the text as written.
  const draft: Draft = { kind: 'email', source: 'See https://x.dev' };
  assert.equal(draftPlainText(draft), 'See https://x.dev');
  assert.equal(draftHTML(draft), '<meta charset="utf-8"><div>See https://x.dev</div>');
});

// Cross-lab review, 6 Nov.
test('tokens inside code stay as written, and a link can be bold', () => {
  assert.deepEqual(slackSpans('`<@U123>` and `a < b`'), [{ text: '<@U123>', code: true }, { text: ' and ' }, { text: 'a < b', code: true }]);
  assert.deepEqual(slackSpans('*See <https://x.dev|docs>*'), [{ text: 'See ', bold: true }, { text: 'docs', bold: true, link: 'https://x.dev' }]);
  assert.deepEqual(slackSpans('<https://x.dev|a>_b_'), [{ text: 'a', link: 'https://x.dev' }, { text: 'b', italic: true }]);
  // Copied as plain text, code keeps its tokens as typed too.
  assert.equal(
    draftPlainText({ kind: 'slack', source: '`<@U1>` <@U1> `<https://x.dev|docs>` <https://x.dev|docs>' }),
    '`<@U1>` @U1 `<https://x.dev|docs>` docs (https://x.dev)',
  );
});

test('hostile lines stay quick', () => {
  const start = Date.now();
  slackSpans('<'.repeat(maxFormattedLine));
  slackSpans(' *a'.repeat(maxFormattedLine / 3));
  draftPlainText({ kind: 'slack', source: '<'.repeat(maxSource) });
  draftPlainText({ kind: 'slack', source: '<'.repeat(maxSource - 1) + '>' });
  assert.ok(Date.now() - start < 2000);
  // A line past the limit is shown as written; a draft past its limit stays code.
  const long = '*' + 'a'.repeat(maxFormattedLine) + '*';
  assert.deepEqual(slackSpans(long), [{ text: long }]);
  assert.equal(draftFrom('slack', 'a'.repeat(maxSource + 1)), undefined);
  // A placeholder character in the text itself turns formatting off for the line.
  assert.deepEqual(slackSpans('*a* \u{E000}'), [{ text: '*a* \u{E000}' }]);
});

test('copied html keeps indents and lined up spaces', () => {
  const draft: Draft = { kind: 'email', source: '    • nested\nA    B' };
  assert.equal(draftHTML(draft), '<meta charset="utf-8"><div>&nbsp;&nbsp;&nbsp;&nbsp;• nested<br>A &nbsp;&nbsp;&nbsp;B</div>');
});

test('only a closed fence makes a draft', () => {
  // The node starts at the fence, after any container (react-markdown's
  // position for a fence in a list or a quote).
  const closed = (text: string) => {
    const start = text.search(/[`~]{3}/);
    return fenceClosed(text, start, text.length);
  };
  assert.ok(closed('```slack\nhello\n```'));
  assert.ok(closed('````slack\nhello\n`````'));
  assert.ok(closed('~~~email\nhi\n~~~  '));
  assert.ok(closed('```slack\r\nhello\r\n```'));
  assert.ok(closed('- ```slack\n  hello\n  ```'));
  assert.ok(closed('> ```slack\n> hello\n> ```'));
  assert.ok(closed('1. a\n\n   > ```slack\n   > hi\n   > ```'));
  assert.ok(closed('```slack\nhello\n   ```'));
  assert.ok(closed('  ```slack\n  hello\n```'));
  assert.ok(closed('1. ```slack\n   hello\n   ```'));
  assert.ok(closed('>```slack\n>hello\n>```'));
  assert.ok(closed('> - ```slack\n>   hello\n>   ```'));
  assert.ok(closed('- parent\n  - child\n\n    ```slack\n    hello\n    ```'));
  // Indent isn't checked, so this one shows its box a line early: harmless.
  assert.ok(closed('```slack\nhello\n    ```'));
  assert.ok(!closed('```slack\nhello\n> ```'));
  assert.ok(!closed('> ```slack\n> hello\n```'));
  assert.ok(!closed('```slack\n*unfinished'));
  assert.ok(!closed('```slack\nhello\n~~~'));
  assert.ok(!closed('````slack\nhello\n```'));
  assert.ok(!closed('```slack'));
  // Offsets pick the block out of the whole reply.
  const reply = 'Here:\n\n```slack\nhi\n```\n\nThanks';
  assert.ok(fenceClosed(reply, reply.indexOf('```'), reply.indexOf('```', 10) + 3));
});
