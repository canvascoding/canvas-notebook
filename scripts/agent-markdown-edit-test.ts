import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyAgentMarkdownEdit } from '../app/lib/markdown/agent-markdown-edit';

test('append preserves frontmatter, document line endings, and Markdown structure', () => {
  const source = '---\r\ntitle: Example\r\n---\r\n\r\n# Existing\r\n\r\nBody\r\n';
  const result = applyAgentMarkdownEdit(source, {
    mode: 'append',
    content: '\n# Added\n\n![Preview](image.png)\n',
  }, 'document.md');
  assert.equal(result, '---\r\ntitle: Example\r\n---\r\n\r\n# Existing\r\n\r\nBody\r\n\r\n# Added\n\n![Preview](image.png)\r\n');
});

test('replace uses exact occurrence guards inside the Markdown body', () => {
  const source = '---\ntitle: Keep\n---\n\nAlpha\n\nAlpha\n';
  assert.equal(applyAgentMarkdownEdit(source, {
    mode: 'replace', oldText: 'Alpha', content: '**Beta**', expectedOccurrences: 2,
  }, 'document.md'), '---\ntitle: Keep\n---\n\n**Beta**\n\n**Beta**\n');
  assert.throws(() => applyAgentMarkdownEdit(source, {
    mode: 'replace', oldText: 'title: Keep', content: 'title: Changed',
  }, 'document.md'), /oldText matched 0 time/u);
});

test('insert_after_heading targets one real heading and ignores fenced lookalikes', () => {
  const source = '# Intro\n\n```md\n# Target\n```\n\n# Target\n\nExisting\n';
  assert.equal(applyAgentMarkdownEdit(source, {
    mode: 'insert_after_heading', heading: '# Target', content: '> [!success] Added\n> Render me',
  }, 'document.md'), '# Intro\n\n```md\n# Target\n```\n\n# Target\n\n> [!success] Added\n> Render me\n\nExisting\n');
});

test('insert_after_heading rejects missing and ambiguous headings with actionable locations', () => {
  assert.throws(() => applyAgentMarkdownEdit('# A\n', {
    mode: 'insert_after_heading', heading: 'Missing', content: 'Text',
  }, 'document.md'), /heading "Missing" was not found/u);
  assert.throws(() => applyAgentMarkdownEdit('# A\n\n## A\n', {
    mode: 'insert_after_heading', heading: 'A', content: 'Text',
  }, 'document.md'), /matched 2 headings at lines 1, 3/u);
});
