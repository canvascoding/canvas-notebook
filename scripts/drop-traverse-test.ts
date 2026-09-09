import assert from 'node:assert/strict';
import { getDroppedItems, getDroppedFiles } from '../app/lib/drop-traverse';
import { assertUploadSelectionWithinLimits } from '../app/lib/files/upload-limits';

let active = 0;
let maximum = 0;
const fileEntry = (path: string, fail = false): FileSystemEntry => ({ fullPath: path, isFile: true, isDirectory: false,
  file(ok: (file: File) => void, error: (error: DOMException) => void) {
    maximum = Math.max(maximum, ++active);
    setTimeout(() => { active--; if (fail) error(new DOMException('No access')); else ok(new File(['x'], path.split('/').pop()!)); }, 0);
  },
} as unknown as FileSystemEntry);
function directory(path: string, entries: FileSystemEntry[], fail = false): FileSystemEntry {
  return { fullPath: path, isDirectory: true, isFile: false, createReader() {
    let position = 0;
    return { readEntries(ok: (entries: FileSystemEntry[]) => void, error: (error: DOMException) => void) {
      if (fail) { error(new DOMException('Cannot read directory')); return; }
      const batch = entries.slice(position, position + 100); position += 100; ok(batch);
    } };
  } } as unknown as FileSystemEntry;
}
const transfer = (entries: FileSystemEntry[]) => ({ items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })), files: [] } as unknown as DataTransfer);

async function main() {
  const entries = Array.from({ length: 1000 }, (_, index) => fileEntry(`/root/f${index}.txt`));
  entries.push(directory('/root/nested', [directory('/root/nested/empty', [])]));
  const updates: number[] = [];
  const result = await getDroppedItems(transfer([directory('/root', entries)]), { onProgress: (progress) => updates.push(progress.files) });
  assert.equal(result.files.length, 1000, 'all readEntries batches are consumed');
  assert.ok(maximum <= 8 && maximum > 1, `bounded file reads: ${maximum}`);
  assert.deepEqual(result.emptyDirectories, ['root/nested/empty']);
  assert.equal(updates.at(-1), 1000);
  assert.ok(updates.length > 1, 'collection reports progress before finishing');
  await assert.rejects(getDroppedItems(transfer([directory('/bad', [], true)])), /Cannot read directory/);
  await assert.rejects(getDroppedItems(transfer([fileEntry('/bad.txt', true)])), /No access/);
  await assert.rejects(getDroppedItems(transfer([directory('/too-many', Array.from({ length: 1001 }, (_, i) => fileEntry(`/too-many/${i}`)))])), /1000/);
  const hanging = { fullPath: '/hang', isDirectory: true, createReader: () => ({ readEntries() {} }) } as unknown as FileSystemEntry;
  await assert.rejects(getDroppedItems(transfer([hanging]), { timeoutMs: 5 }), /timed out/);
  const controller = new AbortController();
  const waiting = getDroppedItems(transfer([hanging]), { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const fallback = await getDroppedFiles({ files: [new File(['x'], 'fallback.txt')] } as unknown as DataTransfer);
  assert.equal(fallback[0].relativePath, 'fallback.txt');
  assert.throws(() => assertUploadSelectionWithinLimits(Array.from({ length: 1001 }, () => ({ name: 'image.heic', size: 1 }))), /1000/);
  assert.throws(() => assertUploadSelectionWithinLimits(Array.from({ length: 5 }, () => ({ name: 'video.mp4', size: 5 * 1024 ** 3 }))), /20 GB/);
  console.log('drop-traverse-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
