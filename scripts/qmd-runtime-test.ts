import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  mapQmdFileToOriginalPath,
  mergeQmdResults,
  normalizeQmdCollections,
  normalizeQmdMode,
  QMD_CANONICAL_TOOL_NAME,
  QMD_DEFAULT_COLLECTIONS,
} from '../app/lib/qmd/runtime';

assert.equal(normalizeQmdMode(undefined), 'search');
assert.equal(normalizeQmdMode('vsearch'), 'vsearch');
assert.throws(() => normalizeQmdMode('invalid'));

assert.deepEqual(normalizeQmdCollections(undefined), [...QMD_DEFAULT_COLLECTIONS]);
assert.deepEqual(normalizeQmdCollections('workspace-text'), ['workspace-text']);
assert.deepEqual(normalizeQmdCollections(['workspace-text', 'workspace-derived', 'workspace-text']), [
  'workspace-text',
  'workspace-derived',
]);

assert.deepEqual(mapQmdFileToOriginalPath('docs/test.docx.md', 'workspace-derived'), {
  originalPath: 'docs/test.docx',
  displayPath: 'docs/test.docx',
  sourceType: 'workspace-derived',
});

assert.deepEqual(mapQmdFileToOriginalPath('docs/test.md', 'workspace-text'), {
  originalPath: 'docs/test.md',
  displayPath: 'docs/test.md',
  sourceType: 'workspace-text',
});

const merged = mergeQmdResults([
  {
    docid: '#one',
    score: 0.41,
    file: 'docs/test.docx.md',
    title: 'Test',
    context: null,
    snippet: 'older',
    body: null,
    collection: 'workspace-derived',
    originalPath: 'docs/test.docx',
    displayPath: 'docs/test.docx',
    sourceType: 'workspace-derived',
  },
  {
    docid: '#two',
    score: 0.73,
    file: 'docs/test.docx.md',
    title: 'Test',
    context: null,
    snippet: 'newer',
    body: null,
    collection: 'workspace-derived',
    originalPath: 'docs/test.docx',
    displayPath: 'docs/test.docx',
    sourceType: 'workspace-derived',
  },
]);

assert.equal(merged.length, 1);
assert.equal(merged[0]?.score, 0.73);

async function main() {
  const toolRegistry = await fs.readFile(new URL('../app/lib/pi/tool-registry.ts', import.meta.url), 'utf8');

  assert.equal(QMD_CANONICAL_TOOL_NAME, 'qmd');
  assert.match(toolRegistry, /createQmdTool\(QMD_CANONICAL_TOOL_NAME\)/);
  assert.match(toolRegistry, /createQmdTool\('qmd_search', true\)/);
  assert.match(toolRegistry, /workspace-text/);
  assert.match(toolRegistry, /query mode is disabled by default/);

  console.log('QMD runtime test passed');
}

void main();
