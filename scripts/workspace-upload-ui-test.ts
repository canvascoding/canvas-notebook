import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

const dialog = read('app/components/file-browser/UploadDialog.tsx');
const progress = read('app/components/file-browser/UploadProgress.tsx');
const store = read('app/store/file-store.ts');
const german = JSON.parse(read('messages/de.json')) as { notebook: Record<string, string> };
const english = JSON.parse(read('messages/en.json')) as { notebook: Record<string, string> };

assert.match(store, /uploadItems:\s*WorkspaceUploadFileProgress\[\]/u);
assert.match(store, /onFileProgress:\s*\(progress\)/u);
assert.match(dialog, /<UploadProgress value=\{visibleProgress\} items=\{uploadItems\}/u);
assert.match(dialog, /role="alert"/u);
assert.match(dialog, /max-h-32 overflow-y-auto break-words/u);
assert.match(progress, /item\.status === 'retrying'/u);
assert.match(progress, /uploadBatchProgress/u);
assert.match(progress, /uploadFailedCount/u);

for (const messages of [german.notebook, english.notebook]) {
  assert.ok(messages.uploadBatchProgress);
  assert.ok(messages.uploadCurrentFile);
  assert.ok(messages.uploadRetryingFile);
  assert.ok(messages.uploadFailedCount);
}

console.log('workspace-upload-ui-test: ok');
