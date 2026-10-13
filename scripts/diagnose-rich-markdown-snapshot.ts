import { readFile, stat } from 'node:fs/promises';
import { diagnoseRichMarkdownSnapshot, MAX_PRIVATE_YJS_SNAPSHOT_BYTES } from './helpers/rich-markdown-projection-diagnosis';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('Usage: tsx --conditions react-server scripts/diagnose-rich-markdown-snapshot.ts <private-yjs-update.bin>');
    process.exitCode = 2;
    return;
  }
  try {
    const file = await stat(args[0]);
    if (!file.isFile() || file.size > MAX_PRIVATE_YJS_SNAPSHOT_BYTES) {
      console.error(JSON.stringify({ version: 1, error: 'snapshot_unavailable_or_size_limit' }));
      process.exitCode = 2;
      return;
    }
    const report = diagnoseRichMarkdownSnapshot(await readFile(args[0]));
    console.log(JSON.stringify(report, null, 2));
    if (report.decode !== 'valid' || report.representation === 'unsupported' || !report.completeUpdate) process.exitCode = 2;
  } catch {
    // Filesystem and decoder errors may contain private paths or source bytes.
    console.error(JSON.stringify({ version: 1, error: 'snapshot_unavailable' }));
    process.exitCode = 2;
  }
}

void main();
