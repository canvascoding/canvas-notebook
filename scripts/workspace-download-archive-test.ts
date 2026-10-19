import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

type Entry = { archivePath: string; fullPath: string | null; stats?: Awaited<ReturnType<typeof fs.stat>>; type: 'file' | 'directory' };
type ArchiveMethods = {
  collectArchiveEntries(paths: string[], options: object): Promise<Entry[]>;
  writeArchive(entries: Entry[]): Promise<{ archivePath: string; tempDirectory: string }>;
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-download-contract-'));
  const requireDependency = createRequire(import.meta.url);
  const routePath = path.resolve('app/api/files/download/route.ts');
  const actualFile = path.join(root, 'actual.txt'); await fs.writeFile(actualFile, 'before');
  const fileStats = await fs.stat(actualFile); const directoryStats = await fs.stat(root);
  // A case-insensitive macOS filesystem cannot hold both names. Only that
  // directory listing is substituted; the production archive planner runs intact.
  const virtualFs = { ...fs,
    readdir: async (filename: string, options: unknown) => filename === path.join(root, 'case-conflict')
      ? [{ name: 'Report.txt' }, { name: 'report.txt' }]
      : fs.readdir(filename, options as { withFileTypes: true }),
    lstat: async (filename: string) => filename === path.join(root, 'case-conflict') ? directoryStats
      : filename.startsWith(path.join(root, 'case-conflict') + path.sep) ? fileStats : fs.lstat(filename),
  };
  const javascript = ts.transpileModule(readFileSync(routePath, 'utf8')
    + '\nexport const archiveContractMethods = { collectArchiveEntries, writeArchive };', {
    fileName: routePath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const evaluated = { exports: {} as { archiveContractMethods: ArchiveMethods } };
  const load = (name: string) => {
    if (name === 'fs') return { ...requireDependency('node:fs'), promises: virtualFs };
    if (name === '@/app/lib/filesystem/workspace-files') return { validatePath: (relative: string) => path.join(root, relative) };
    if (name.startsWith('@/')) return {};
    return requireDependency(name);
  };
  new Function('require', 'module', 'exports', javascript)(load, evaluated, evaluated.exports);
  const { collectArchiveEntries, writeArchive } = evaluated.exports.archiveContractMethods;
  const rejections: unknown[] = [];
  const recordRejection = (error: unknown) => rejections.push(error);
  process.on('unhandledRejection', recordRejection);
  try {
    await assert.rejects(() => collectArchiveEntries(['case-conflict'], {}),
      (error: unknown) => (error as { code?: string }).code === 'ARCHIVE_NAME_CONFLICT');
    console.log('PASS: conflicting case-folded ZIP entry names are rejected.');
    const plan = await collectArchiveEntries(['actual.txt'], {});
    await fs.writeFile(actualFile, 'changed source bytes');
    await assert.rejects(() => writeArchive(plan),
      (error: unknown) => (error as { code?: string }).code === 'ARCHIVE_SOURCE_CHANGED');
    console.log('PASS: a file changed after planning is rejected before ZIP publication.');
    await delay(50);
    assert.equal(rejections.length, 0, 'Source-change rejection must also settle the output stream completion promise.');
  } finally {
    process.off('unhandledRejection', recordRejection);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
