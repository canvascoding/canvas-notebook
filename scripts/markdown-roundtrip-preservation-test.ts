import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  analyzeMarkdownRichMode,
  restoreRichMarkdownFinalLineEnding,
  serializeRichMarkdownBody,
} from '../app/lib/markdown/rich-markdown-codec';
import {
  composeCanvasMarkdownDocument,
  splitCanvasMarkdownForRichEditor,
} from '../app/lib/markdown/obsidian-metadata';
import { hasMarpDirective } from '../app/lib/marp/detect';
import { getMarkdownSourceModeNotice } from '../app/lib/markdown/source-mode-notice';
import { equivalentMarkdownNormalization } from '../app/lib/markdown/core/equivalence';

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'markdown-roundtrip');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureRoot, name), 'utf8');
}

const safeFixture = readFixture('marp-frontmatter-safe.md');
const safeParts = splitCanvasMarkdownForRichEditor(safeFixture);
assert.equal(composeCanvasMarkdownDocument(safeParts.prefix, safeParts.body), safeFixture);
assert.deepEqual(analyzeMarkdownRichMode(safeFixture), {
  mode: 'rich',
  prefix: safeParts.prefix,
  body: safeParts.body,
});

assert.equal(serializeRichMarkdownBody(safeParts.body), safeParts.body);

assert.equal(
  restoreRichMarkdownFinalLineEnding('Paragraph\n', 'Paragraph\n\n'),
  'Paragraph\n',
  'a rich-editor-only trailing paragraph must not duplicate the preserved LF terminator',
);
assert.equal(
  restoreRichMarkdownFinalLineEnding('Paragraph\r\n', 'Paragraph\n\n'),
  'Paragraph\r\n',
  'the preserved CRLF terminator must replace serializer-generated trailing line endings',
);
assert.equal(
  restoreRichMarkdownFinalLineEnding('Paragraph', 'Paragraph\n\n'),
  'Paragraph',
  'a document without a final terminator must not gain one from an empty editor paragraph',
);
assert.equal(
  restoreRichMarkdownFinalLineEnding('First\n\nSecond\n', 'First\n\nSecond\n\n'),
  'First\n\nSecond\n',
  'canonicalizing the EOF must preserve internal blank lines',
);

const directiveFixture = readFixture('marp-directive-source-only.md');
assert.deepEqual(analyzeMarkdownRichMode(directiveFixture), {
  mode: 'source',
  reason: 'unsupported_marp_directive',
});
assert.equal(getMarkdownSourceModeNotice('unsupported_marp_directive', true), 'presentation');
assert.equal(getMarkdownSourceModeNotice('unsupported_marp_directive', false), 'markdown');
assert.equal(getMarkdownSourceModeNotice('roundtrip_changed', false), 'markdown');
assert.equal(hasMarpDirective(safeFixture), true);
assert.equal(hasMarpDirective('---\nmarp: "true"\n---\n# Slide\n'), true);
assert.equal(hasMarpDirective('---\nmarp: false\n---\n# Note\n'), false);

const invalidFrontmatter = '---\n: invalid: yaml\n---\n# Body\n';
assert.deepEqual(analyzeMarkdownRichMode(invalidFrontmatter), {
  mode: 'source',
  reason: 'invalid_frontmatter',
});

const crlfBody = '---\r\nmarp: true\r\n---\r\n\r\n# Slide\r\n';
assert.equal(analyzeMarkdownRichMode(crlfBody).mode, 'rich');

const bareEmailFixture = '**An:** online.vertrieb@ista.de  \n**Betreff:** Angebot\n';
assert.deepEqual(analyzeMarkdownRichMode(bareEmailFixture), {
  mode: 'rich',
  prefix: '',
  body: bareEmailFixture,
});

const explicitEmailLink = '[online.vertrieb@ista.de](mailto:online.vertrieb@ista.de)\n';
assert.deepEqual(analyzeMarkdownRichMode(explicitEmailLink), {
  mode: 'rich',
  prefix: '',
  body: explicitEmailLink,
});

const emailAutolink = '**Canvas <team@example.test>**\n';
const normalizedEmailAutolink = '**Canvas [team@example.test](mailto:team@example.test)**\n';
assert.deepEqual(analyzeMarkdownRichMode(emailAutolink), {
  mode: 'normalizable', prefix: '', body: emailAutolink,
  normalizedBody: normalizedEmailAutolink, normalizations: ['email_link_formatting'],
});
assert.equal(serializeRichMarkdownBody(normalizedEmailAutolink), normalizedEmailAutolink);
assert.equal(analyzeMarkdownRichMode(normalizedEmailAutolink).mode, 'rich');

const mailtoTaskList = readFixture('mailto-task-list.md');
const mailtoTaskListAnalysis = analyzeMarkdownRichMode(mailtoTaskList);
assert.equal(mailtoTaskListAnalysis.mode, 'normalizable');
if (mailtoTaskListAnalysis.mode !== 'normalizable') throw new Error('Mail/task fixture must offer safe normalization.');
assert.deepEqual(mailtoTaskListAnalysis.normalizations, ['list_formatting', 'email_link_formatting']);
assert.match(mailtoTaskListAnalysis.normalizedBody, /\[Support\]\(mailto:support@example\.test\?subject=Hello%20world\)/u);
assert.equal(analyzeMarkdownRichMode(mailtoTaskListAnalysis.normalizedBody).mode, 'rich');

for (const [before, after] of [
  ['<one@example.test>\n', '[one@example.test](mailto:two@example.test)\n'],
  ['<one@example.test>\n', '[Changed](mailto:one@example.test)\n'],
  ['one@example.test\n', '[one@example.test](mailto:one@example.test)\n'],
  ['[Support](mailto:one@example.test?subject=Original)\n', '[Support](mailto:one@example.test?subject=Changed)\n'],
  ['[Support](mailto:one@example.test "Original title")\n', '[Support](mailto:one@example.test "Changed title")\n'],
  ['- [x] Complete\n- Ordinary\n', '- [ ] Complete\n\n- Ordinary\n'],
  ['- [x] Keep [ ] literal\n', '- [x] Keep literal\n'],
  ['1. [x] First\n2. Ordinary\n', '- [x] First\n- Ordinary\n'],
]) {
  assert.equal(equivalentMarkdownNormalization(before, after), null, 'Normalization must retain link identity, label and task semantics.');
}

const literalThematicBreak = '\\---\n';
assert.deepEqual(analyzeMarkdownRichMode(literalThematicBreak), {
  mode: 'rich',
  prefix: '',
  body: literalThematicBreak,
});

const normalizableFixture = readFixture('techem-safe-normalization.md');
const normalizableParts = splitCanvasMarkdownForRichEditor(normalizableFixture);
const normalizedBody = serializeRichMarkdownBody(normalizableParts.body);
assert.notEqual(normalizedBody, normalizableParts.body);
assert.deepEqual(analyzeMarkdownRichMode(normalizableFixture), {
  mode: 'normalizable',
  prefix: normalizableParts.prefix,
  body: normalizableParts.body,
  normalizedBody,
  normalizations: ['ordered_list_spacing', 'hard_break_marker'],
});
assert.deepEqual(
  analyzeMarkdownRichMode(composeCanvasMarkdownDocument(normalizableParts.prefix, normalizedBody)),
  {
    mode: 'rich',
    prefix: normalizableParts.prefix,
    body: normalizedBody,
  },
);

assert.deepEqual(analyzeMarkdownRichMode('```text\nvalue\\\n```\n'), {
  mode: 'rich',
  prefix: '',
  body: '```text\nvalue\\\n```\n',
});
assert.deepEqual(analyzeMarkdownRichMode('# Raw HTML\n\n<div>keep exactly</div>\n'), {
  mode: 'source',
  reason: 'roundtrip_changed',
});
assert.deepEqual(analyzeMarkdownRichMode('1. Item\n\n   continuation paragraph\n'), {
  mode: 'rich',
  prefix: '',
  body: '1. Item\n\n   continuation paragraph\n',
});

const entityFixture = '# Research & Development\n\nA < B > C\n';
assert.deepEqual(analyzeMarkdownRichMode(entityFixture), {
  mode: 'normalizable',
  prefix: '',
  body: entityFixture,
  normalizedBody: serializeRichMarkdownBody(entityFixture),
  normalizations: ['html_entity_escaping'],
});

const tableFixture = [
  '# Options',
  '',
  '| Name | Meaning |',
  '| ---- | ------- |',
  '| **Bradley** | Calm help inside Canvas Notebook |',
  '| **Lino** | Woven structure |',
  '',
].join('\n');
assert.deepEqual(analyzeMarkdownRichMode(tableFixture), {
  mode: 'normalizable',
  prefix: '',
  body: tableFixture,
  normalizedBody: serializeRichMarkdownBody(tableFixture),
  normalizations: ['table_formatting'],
});

const brandedTableFixture = tableFixture.replace('# Options', '# Brand & UI options');
const brandedTableNormalized = serializeRichMarkdownBody(brandedTableFixture);
assert.deepEqual(analyzeMarkdownRichMode(brandedTableFixture), {
  mode: 'normalizable',
  prefix: '',
  body: brandedTableFixture,
  normalizedBody: brandedTableNormalized,
  normalizations: ['html_entity_escaping', 'table_formatting'],
});
assert.equal(analyzeMarkdownRichMode(brandedTableNormalized).mode, 'rich');

const koenenstrasseFixture = readFixture('koenenstrasse-email-roundtrip.md');
const koenenstrasseParts = splitCanvasMarkdownForRichEditor(koenenstrasseFixture);
const koenenstrasseNormalizedBody = serializeRichMarkdownBody(koenenstrasseParts.body);
assert.deepEqual(analyzeMarkdownRichMode(koenenstrasseFixture), {
  mode: 'normalizable',
  prefix: koenenstrasseParts.prefix,
  body: koenenstrasseParts.body,
  normalizedBody: koenenstrasseNormalizedBody,
  normalizations: ['escaped_email_address', 'hard_break_marker', 'table_formatting'],
});
assert.deepEqual(
  analyzeMarkdownRichMode(composeCanvasMarkdownDocument(
    koenenstrasseParts.prefix,
    koenenstrasseNormalizedBody,
  )),
  {
    mode: 'rich',
    prefix: koenenstrasseParts.prefix,
    body: koenenstrasseNormalizedBody,
  },
);

const markdownEditorSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'components', 'editor', 'MarkdownEditor.tsx'),
  'utf8',
);
assert.match(markdownEditorSource, /data-testid="markdown-safe-normalization-notice"/u);
assert.match(markdownEditorSource, /data-testid="markdown-normalize-rich-text"/u);
assert.match(
  markdownEditorSource,
  /composeCanvasMarkdownDocument\(\s*richModeAnalysis\.prefix,\s*richModeAnalysis\.normalizedBody/u,
);

for (const locale of ['en', 'de']) {
  const messages = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'messages', `${locale}.json`),
    'utf8',
  )) as { notebook?: Record<string, string> };
  assert.ok(messages.notebook?.markdownEditorSafeNormalizationNotice);
  assert.ok(messages.notebook?.markdownEditorNormalizeAndOpenRichText);
  assert.ok(messages.notebook?.markdownEditorNormalizedForRichText);
}

console.log('markdown-roundtrip-preservation-test: ok');
