import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import type { FileReferenceEntry } from '../app/lib/filesystem/file-reference-search';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const deep = Array.from({ length: 18 }, (_, index) => `level-${index}`).join('/');
  const entries: FileReferenceEntry[] = Array.from({ length: 10_050 }, (_, index) => ({
    path: `other-${index}.txt`, name: `other-${index}.txt`, type: 'file', extension: 'txt', isImage: false, size: 1, modified: index,
  }));
  entries.push({ path: `${deep}/needle.png`, name: 'needle.png', type: 'file', extension: 'png', isImage: true, size: 4, modified: 1 });
  entries.push({ path: `${deep}/empty`, name: 'empty', type: 'directory', isImage: false, modified: 1 });
  for (let index = 0; index < 5_050; index += 1) entries.push({ path: `doc-${index}.md`, name: `doc-${index}.md`,
    type: 'file', extension: 'md', isImage: false, size: 1, modified: index });
  entries.push({ path: `${deep}/needle.md`, name: 'needle.md', type: 'file', extension: 'md', isImage: false, size: 1, modified: 1 });
  const workspace = { workspaceId: 'owned-workspace', permissions: { canRead: true, canWrite: true, canDelete: true } } as WorkspaceContext;
  const requests: unknown[] = [];
  const mocks: Record<string, unknown> = {
    'server-only': {},
    '@/app/lib/filesystem/file-reference-cache': {
      getCachedWorkspaceReferenceEntries: async (_force: boolean, options: unknown) => { requests.push(options); return entries; },
      getCachedFileReferenceEntries: async (_force: boolean, options: unknown) => { requests.push(options); return entries.filter((entry) => entry.type === 'file'); },
    },
    '@/app/lib/filesystem/workspace-files': { readFile: async () => Buffer.from('# Other document'), listDirectory: async () => [] },
    '@/app/lib/public-sharing/public-file-shares': { getPublicShareAnnotations: async () => new Map(), getPublicShareMimeType: () => 'image/png' },
    '@/app/lib/files/workspace-file-metadata': { enrichWorkspaceFileNodes: async ({ nodes }: { nodes: unknown }) => nodes },
  };
  const compile = async (relativePath: string) => {
    const filename = path.resolve(relativePath);
    const native = createRequire(filename);
    const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const exported: Record<string, unknown> = {};
    new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name]
      : name.startsWith('@/app/lib/collaboration/') || name.startsWith('@/app/lib/files/') && name !== '@/app/lib/files/sort'
        || name === './notebook-operations' ? {} : native(name), { exports: exported }, exported);
    return exported;
  };
  const mobileFiles = await compile('app/lib/mobile/files.ts') as typeof import('../app/lib/mobile/files');
  const mobileNotebook = await compile('app/lib/mobile/notebook.ts') as typeof import('../app/lib/mobile/notebook');
  const files = await mobileFiles.listMobileFiles({ workspace, fileOptions: { workspace }, query: 'needle', filter: 'image' });
  assert.equal(files.total, 1);
  assert.equal(files.items[0].path, `${deep}/needle.png`);
  const folders = await mobileFiles.listMobileFiles({ workspace, fileOptions: { workspace }, query: 'empty' });
  assert.equal(folders.items[0].path, `${deep}/empty`);
  const documents = await mobileNotebook.listMobileNotebookDocuments({ workspace, fileOptions: { workspace }, query: 'needle' });
  assert.equal(documents.items[0].path, `${deep}/needle.md`);
  assert.equal(documents.items[0].match, 'title');
  assert.equal(documents.contentSearch?.complete, false);
  assert.equal(documents.contentSearch?.scannedDocuments, 200);
  assert.equal(documents.contentSearch?.totalDocuments, 5_050);
  assert.ok(requests.every((options) => (options as { workspace: WorkspaceContext }).workspace.workspaceId === workspace.workspaceId));
  console.log('mobile-file-discovery-test: 18-level paths beyond 10000 entries and 5000 documents, empty folders, source workspace and explicit content-search coverage passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
