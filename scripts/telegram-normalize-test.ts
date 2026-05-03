import { markdownToTelegramHtml, chunkTelegramMessage } from '../app/lib/channels/telegram/normalize';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  if (actual === expected) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertContains(haystack: string, needle: string, msg: string) {
  if (haystack.includes(needle)) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg} — "${needle}" not found in result`);
    failed++;
  }
}

console.log('markdownToTelegramHtml:');
assertEqual(markdownToTelegramHtml('**hello**'), '<b>hello</b>', 'converts bold');
assertEqual(markdownToTelegramHtml('*hello*'), '<i>hello</i>', 'converts italic');
assertEqual(markdownToTelegramHtml('use `npm install`'), 'use <code>npm install</code>', 'converts inline code');
assertContains(markdownToTelegramHtml('```js\nconsole.log("hi")\n```\nDone'), '<pre>js\nconsole.log(&quot;hi&quot;)\n</pre>', 'converts code blocks');
assertEqual(markdownToTelegramHtml('~~deleted~~'), '<s>deleted</s>', 'converts strikethrough');
assertEqual(markdownToTelegramHtml('[click](https://example.com)'), '<a href="https://example.com/">click</a>', 'converts links');
assertEqual(markdownToTelegramHtml('just text'), 'just text', 'leaves plain text unchanged');
assertEqual(markdownToTelegramHtml('**bold** and `code`'), '<b>bold</b> and <code>code</code>', 'handles mixed formatting');
assertEqual(markdownToTelegramHtml('<b>raw</b> & text'), '&lt;b&gt;raw&lt;/b&gt; &amp; text', 'escapes raw HTML');
assertEqual(markdownToTelegramHtml('[bad](javascript:alert(1))'), 'bad)', 'drops unsafe links');

console.log('\nchunkTelegramMessage:');
const shortChunks = chunkTelegramMessage('short');
assertEqual(shortChunks.length, 1, 'single chunk for short text');
assertEqual(shortChunks[0], 'short', 'short text unchanged');

const atLimit = chunkTelegramMessage('a'.repeat(4000));
assertEqual(atLimit.length, 1, 'single chunk at max length');

const longChunks = chunkTelegramMessage('a'.repeat(8000), 4000);
assert(longChunks.length >= 2, 'splits long text into multiple chunks');
for (const chunk of longChunks) {
  assert(chunk.length <= 4500, `chunk length ${chunk.length} within tolerance`);
}

const paragraphs = Array(200).fill('A normal paragraph.').join('\n\n');
const paraChunks = chunkTelegramMessage(paragraphs, 1000);
assert(paraChunks.length > 1, 'splits at paragraph boundaries');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
