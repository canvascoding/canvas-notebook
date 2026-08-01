import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const editorSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'MarkdownEditor.tsx'),
  'utf8',
);
const editorStyles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');

assert.match(
  editorSource,
  /data-testid="markdown-find-bar"/u,
  'the rich search UI must expose a stable test target',
);
assert.match(
  editorSource,
  /if \(key === 'f'\)[\s\S]*?setFindOpen\(true\)/u,
  'Cmd/Ctrl+F must open rich-editor search',
);
assert.match(
  editorSource,
  /markdownEditorFindPrevious[\s\S]*?markdownEditorFindNext/u,
  'the search bar must expose previous and next match controls',
);
assert.match(
  editorSource,
  /<MarkdownDocumentStatus[\s\S]*?value=\{value\}/u,
  'document statistics must track the current Markdown value',
);
assert.ok(
  editorStyles.includes('.markdown-search-match-current'),
  'the current search result must be visually distinct',
);

console.log('markdown-search-stats-ui-test: ok');
