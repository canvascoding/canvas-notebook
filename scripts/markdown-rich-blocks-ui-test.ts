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

for (const command of ['callout', 'details', 'footnote', 'inlineMath', 'blockMath']) {
  const start = editorSource.indexOf(`id: '${command}'`);
  const end = editorSource.indexOf("\n  {", start + 1);
  assert.notEqual(start, -1, `${command} must have a slash-command definition`);
  assert.doesNotMatch(
    editorSource.slice(start, end === -1 ? undefined : end),
    /window\.prompt/u,
    `${command} must use the editor dialog instead of a browser prompt`,
  );
}

assert.match(
  editorSource,
  /function MarkdownRichBlockDialog/u,
  'rich Markdown blocks must use a shared editor dialog',
);
assert.match(
  editorSource,
  /function MarkdownLatexPreview/u,
  'the formula dialog must render a LaTeX preview before insertion',
);
assert.match(
  editorSource,
  /openRichBlockDialog: openRichBlockDialogFromSlash/u,
  'slash commands must share the same dialog insertion path as the toolbar',
);
assert.match(
  editorSource,
  /insertMathAtRange[\s\S]*?deleteRange[\s\S]*?insertInlineMath/u,
  'inline formulas must delete a selected/slash range before calculating their insert position',
);
assert.match(
  editorSource,
  /handleDetailsToggle/u,
  'toggling a collapsible section must persist its open state in the editor document',
);
assert.match(
  editorSource,
  /handleDetailsSummaryClick[\s\S]*?setDetailsOpen/u,
  'clicking the native details summary must persist the open state without a second toggle control',
);
assert.doesNotMatch(
  editorSource,
  /canvas-details-toggle/u,
  'collapsible sections must not render a detached duplicate toggle button',
);
assert.match(
  editorSource,
  /focusFootnoteDefinition/u,
  'footnote references must navigate to their editable definition',
);

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

assert.match(
  editorStyles,
  /summary\[data-type='canvas-details-summary'\][\s\S]*?cursor: pointer/u,
  'collapsible summaries must visibly communicate that they can be toggled',
);
assert.match(
  editorStyles,
  /sup\[data-type='markdown-footnote-reference'\][\s\S]*?cursor: pointer/u,
  'footnote references must visibly communicate that they are navigable',
);
assert.match(
  editorStyles,
  /\.tiptap-editor-shell\s*\{[\s\S]*?min-height: max\(100%, 32rem\)/u,
  'the Markdown editor must provide a substantial blank writing surface',
);
assert.match(
  editorStyles,
  /\.tiptap-editor-shell \.ProseMirror\s*\{[\s\S]*?min-height: max\(100%, 32rem\)/u,
  'the editable canvas must fill the blank writing surface',
);

console.log('markdown-rich-blocks-ui-test: ok');
