import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownRenderer } from '../app/components/shared/MarkdownRenderer';
import { splitMarkdownEditorDocument } from '../app/lib/markdown/editor-document';
import { analyzeMarkdownRichMode, serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';

const yaml = '---\ntitle: PROMPT_YAML_SENTINEL\ntags: [automation]\n---\n\n# Task\n';
const invalidYaml = '---\ntitle: [unfinished\n---\n\n# Task\n';
const thematicBreak = '---\n\nA separator starts this prompt.\n';
const samples = [
  '',
  yaml,
  invalidYaml,
  yaml.replaceAll('\n', '\r\n'),
  `\uFEFF${yaml}`,
  thematicBreak,
  '# Task\n\n' + 'A long prompt paragraph.\n\n'.repeat(200),
  '```yaml\ntitle: literal code\n```\n',
];

for (const content of samples) {
  const parts = splitMarkdownEditorDocument(content, 'content');
  assert.equal(parts.prefix, '', 'a prompt must never acquire hidden metadata');
  assert.equal(parts.body, content, 'the full prompt, including YAML and line endings, is editable content');
  const analysis = analyzeMarkdownRichMode(content, 'content');
  if (analysis.mode === 'source') {
    assert.notEqual(analysis.reason, 'invalid_frontmatter', 'a prompt does not require valid YAML metadata');
  } else {
    assert.equal(analysis.prefix, '');
    assert.equal(analysis.body, content);
    if (analysis.mode === 'rich') assert.equal(serializeRichMarkdownBody(content), content);
  }
}

assert.deepEqual(analyzeMarkdownRichMode(thematicBreak, 'content'), {
  mode: 'rich', prefix: '', body: thematicBreak,
});
assert.deepEqual(analyzeMarkdownRichMode(yaml, 'content'), {
  mode: 'source', reason: 'roundtrip_changed',
}, 'YAML that would serialize as a Markdown heading must stay in lossless Source mode');

const promptPreview = renderToStaticMarkup(<MarkdownRenderer content={yaml} frontmatter="content" />);
assert.match(promptPreview, /PROMPT_YAML_SENTINEL/);
assert.match(promptPreview, /automation/);
assert.match(promptPreview, /Task/);
const invalidPreview = renderToStaticMarkup(<MarkdownRenderer content={invalidYaml} frontmatter="content" />);
assert.match(invalidPreview, /unfinished/);

const documentPreview = renderToStaticMarkup(<MarkdownRenderer content={yaml} />);
assert.doesNotMatch(documentPreview, /PROMPT_YAML_SENTINEL/);
assert.match(documentPreview, /Task/);
const documentParts = splitMarkdownEditorDocument(yaml, 'metadata');
assert.equal(documentParts.prefix + documentParts.body, yaml);
assert.match(documentParts.prefix, /PROMPT_YAML_SENTINEL/);
assert.equal(analyzeMarkdownRichMode(yaml).mode, 'rich');
assert.deepEqual(analyzeMarkdownRichMode(invalidYaml), { mode: 'source', reason: 'invalid_frontmatter' });

console.log('Markdown field content and document metadata regression tests passed.');
