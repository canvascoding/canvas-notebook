import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { resolveCanvasDataRoot } from '../app/lib/runtime-data-paths';

function main(): void {
  if (process.platform !== 'linux') return;
  const root = resolveCanvasDataRoot();
  try {
    lstatSync(path.join(root, 'canvas-native-storage-binding.json'));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const helper = path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts/runtime/native-storage-witness.py');
  const result = spawnSync(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3',
    ['-I', helper, '--root', root, '--initialize-binding'], { timeout: 3000, stdio: 'ignore' });
  if (result.status !== 0) {
    console.warn('[entrypoint] Native storage continuity could not be recorded. Existing storage checks remain in effect.');
  }
}

try {
  main();
} catch {
  console.warn('[entrypoint] Native storage continuity could not be inspected. Existing storage checks remain in effect.');
}
