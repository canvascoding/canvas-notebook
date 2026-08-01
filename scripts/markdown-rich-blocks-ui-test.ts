import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const editorSource = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'MarkdownEditor.tsx'),
  'utf8',
);
const editorStyles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const collaborationSource = fs.readFileSync(
  path.join(root, 'app', 'lib', 'collaboration', 'markdown-state.ts'),
  'utf8',
);

for (const command of ['callout', 'details', 'footnote', 'highlight']) {
  assert.match(
    editorSource,
    new RegExp(`id: '${command}'`, 'u'),
    `${command} must be available from the Markdown slash menu`,
  );
  assert.match(
    editorSource,
    new RegExp(`labels\\.items\\.${command}\\.title`, 'u'),
    `${command} must expose a localized toolbar or command label`,
  );
}

assert.match(
  editorSource,
  /toggleCanvasHighlight\(\)/u,
  'highlight must be directly available in the desktop and mobile editing controls',
);
assert.match(
  editorSource,
  /MOBILE_BLOCK_COMMAND_IDS[\s\S]*?'callout'[\s\S]*?'details'[\s\S]*?'footnote'/u,
  'callout, details, and footnote must be available from the mobile block sheet',
);
assert.match(
  collaborationSource,
  /\.\.\.canvasRichMarkdownExtensions\(\)/u,
  'the server collaboration schema must use the same rich Markdown extensions as the browser',
);

for (const selector of [
  "mark[data-type='canvas-highlight']",
  "[data-type='canvas-callout']",
  "details[data-type='canvas-details']",
  "[data-type='markdown-footnote-definition']",
]) {
  assert.ok(
    editorStyles.includes(selector),
    `${selector} must have an intentional rich-editor presentation`,
  );
}

console.log('markdown-rich-blocks-ui-test: ok');
