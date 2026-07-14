import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';

import {
  extractWorkspaceZip,
  ZipExtractionError,
} from '../app/lib/filesystem/zip-extraction';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function createWorkspace(rootPath: string): WorkspaceContext {
  return {
    workspaceId: 'zip-extraction-test',
    workspaceType: 'personal',
    rootPath,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };
}

async function writeZip(rootPath: string, fileName: string, entries: Record<string, string>): Promise<void> {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  await fs.writeFile(path.join(rootPath, fileName), await zip.generateAsync({ type: 'nodebuffer' }));
}

async function main() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-zip-extraction-'));
  const options = { workspace: createWorkspace(rootPath) };

  try {
    await writeZip(rootPath, 'project.zip', {
      'readme.md': '# Project\n',
      'src/index.ts': 'export const value = 1;\n',
    });

    const result = await extractWorkspaceZip('project.zip', '.', options);
    assert.deepEqual(result.files.sort(), ['readme.md', 'src/index.ts']);
    assert.equal(await fs.readFile(path.join(rootPath, 'readme.md'), 'utf-8'), '# Project\n');
    assert.equal(await fs.readFile(path.join(rootPath, 'src', 'index.ts'), 'utf-8'), 'export const value = 1;\n');

    await fs.writeFile(path.join(rootPath, 'existing.txt'), 'keep this file\n');
    await writeZip(rootPath, 'collision.zip', {
      'existing.txt': 'replace me\n',
      'new-file.txt': 'must not be written\n',
    });
    await assert.rejects(
      () => extractWorkspaceZip('collision.zip', '.', options),
      (error) => error instanceof ZipExtractionError && error.status === 409,
    );
    assert.equal(await fs.readFile(path.join(rootPath, 'existing.txt'), 'utf-8'), 'keep this file\n');
    await assert.rejects(() => fs.access(path.join(rootPath, 'new-file.txt')));

    await writeZip(rootPath, 'unsafe.zip', { '../outside.txt': 'not allowed\n' });
    await assert.rejects(
      () => extractWorkspaceZip('unsafe.zip', '.', options),
      (error) => error instanceof ZipExtractionError && /invalid file path/i.test(error.message),
    );
    await assert.rejects(() => fs.access(path.join(path.dirname(rootPath), 'outside.txt')));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

void main();
