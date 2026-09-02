import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('loads electron-updater through its CommonJS-compatible default export', async () => {
  const mainModulePath = new URL('./main.mjs', import.meta.url);
  const source = await readFile(fileURLToPath(mainModulePath), 'utf8');

  assert.match(source, /import electronUpdater from 'electron-updater';/);
  assert.match(source, /const \{ autoUpdater \} = electronUpdater;/);
  assert.doesNotMatch(source, /import \{ autoUpdater \} from 'electron-updater';/);
});
