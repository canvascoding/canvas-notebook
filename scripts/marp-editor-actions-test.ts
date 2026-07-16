import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const fileEditorPath = path.join(
    process.cwd(),
    'app',
    'components',
    'editor',
    'FileEditor.tsx',
  );
  const source = await readFile(fileEditorPath, 'utf-8');

  assert.match(
    source,
    /if \(isMarpMarkdownFile\) \{\s+setMarpExportOpen\(true\);\s+return;\s+\}/u,
    'The open-file share action must route Marp decks to the Marp export dialog.',
  );
  assert.match(
    source,
    /\{\(\(isMarkdown && !isMarpMarkdownFile\) \|\| isHtml\) && currentFile && \(\s+<ShareMarkdownDialog/u,
    'The normal Markdown share dialog must not render for Marp decks.',
  );
  assert.match(
    source,
    /\{isMarpMarkdownFile && currentFile && \(\s+<MarpExportDialog[\s\S]*?open=\{marpExportOpen\}/u,
    'The Marp export dialog must be available from the open-file view.',
  );

  console.log('marp-editor-actions-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
