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

  const editorSyncGuardIndex = source.indexOf('if (activePath !== currentFile.path)');
  const markdownEditorIndex = source.indexOf('<MarkdownEditor', editorSyncGuardIndex);
  assert.notEqual(
    editorSyncGuardIndex,
    -1,
    'The file editor must wait until the editor draft belongs to the current file.',
  );
  assert.equal(
    markdownEditorIndex > editorSyncGuardIndex,
    true,
    'The synchronized-file guard must run before the Markdown editor mounts.',
  );
  assert.match(
    source.slice(editorSyncGuardIndex, markdownEditorIndex),
    /return <FileLoadingSkeleton path=\{currentFile\.path\} \/>;/u,
    'A file transition must keep showing a loading state instead of mounting with the previous draft.',
  );

  console.log('marp-editor-actions-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
