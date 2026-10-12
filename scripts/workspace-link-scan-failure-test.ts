import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as indexCore from '../app/lib/markdown/workspace-link-index-core';
import * as diagnosisCore from '../app/lib/markdown/workspace-link-diagnostics';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';
import * as sources from '../app/lib/pi/agent-file-link-sources';
import type { AgentFileChangeResult } from '../app/lib/pi/agent-file-operations';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

/** Compile the real adapters while replacing only filesystem and mutation boundaries. */
async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', compiled)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as T;
}

async function main() {
  const workspace: WorkspaceContext = { workspaceId: `scan-failure-${randomUUID()}`,
    workspaceType: 'personal', rootPath: '/synthetic-link-scan', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: false, canManageWorkspace: false,
      canCreatePublicLinks: false, canRunAgent: true } };
  const content = '---\ntitle: 😀\n---\n[[B]]\n[link](B.md)\n';
  const scanError = Object.assign(new Error('synthetic nested catalogue failure'), { code: 'EACCES' });
  let blocked = true;
  let rootReads = 0;
  const filesystem = {
    listDirectory: async (directory: string, options: { strictMetadata?: boolean }) => {
      assert.equal(options.strictMetadata, true);
      if (directory === '.') {
        rootReads++;
        return [{ name: 'A.md', path: 'A.md', type: 'file', size: Buffer.byteLength(content) },
          { name: 'B.md', path: 'B.md', type: 'file', size: 3 },
          { name: 'nested', path: 'nested', type: 'directory' }];
      }
      if (blocked) throw scanError;
      return [{ name: 'other.md', path: 'nested/other.md', type: 'file', size: 3 }];
    },
    readFile: async (filePath: string) => Buffer.from(filePath === 'A.md' ? content : '# B'),
  };
  const references = await compile<typeof import('../app/lib/filesystem/file-reference-cache')>(
    'app/lib/filesystem/file-reference-cache.ts', { './workspace-files': filesystem });
  const index = await compile<typeof import('../app/lib/markdown/workspace-link-index')>(
    'app/lib/markdown/workspace-link-index.ts', {
      '@/app/lib/files/write-service': {}, '@/app/lib/filesystem/file-reference-cache': references,
      '@/app/lib/filesystem/workspace-files': filesystem, './workspace-link-index-core': indexCore,
    });
  const runtime = await compile<typeof import('../app/lib/pi/agent-file-link-diagnostics')>(
    'app/lib/pi/agent-file-link-diagnostics.ts', {
      '@/app/lib/markdown/workspace-link-index': index, '@/app/lib/markdown/workspace-link-index-core': indexCore,
      '@/app/lib/markdown/workspace-link-diagnostics': diagnosisCore,
      '@/app/lib/markdown/workspace-link-limits': { MAX_INDEXED_MARKDOWN_BYTES },
      './agent-file-operations': { getAgentWorkspaceContext: () => workspace }, './agent-file-link-sources': sources,
    });
  const result: AgentFileChangeResult = sources.captureAgentFileLinkSource({
    path: 'A.md', resolvedPath: `${workspace.rootPath}/A.md`, changed: true, snapshot: null,
    beforeSha256: null, afterSha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content), diff: '(synthetic)', validation: { ok: true, checks: [] },
  }, { content, basis: 'applied' });
  const diagnose = runtime.createAgentFileLinkDiagnostics();
  try {
    await assert.rejects(index.buildWorkspaceLinkIndex({ workspace }), (error) => error === scanError);
    const [failed] = await diagnose([result]);
    assert.equal(failed.linkDiagnostics?.status, 'unavailable');
    assert.deepEqual(failed.linkDiagnostics?.counts,
      { checked: 0, resolved: 0, missing: 0, ambiguous: 0, unverified: 1 });
    assert.equal(failed.afterSha256, result.afterSha256);
    assert.equal(failed.changed, true, 'diagnostics must preserve the durable mutation receipt');
    blocked = false;
    const [recovered] = await diagnose([result]);
    assert.equal(recovered.linkDiagnostics?.status, 'complete');
    assert.deepEqual(recovered.linkDiagnostics?.counts,
      { checked: 2, resolved: 2, missing: 0, ambiguous: 0, unverified: 0 });
    assert.equal(rootReads, 3, 'failed partial scans must not become successful cached catalogues');
  } finally { references.invalidateFileReferenceCache({ workspace }); }
  console.log('workspace-link-scan-failure-test: connected catalogue/index/diagnostics failure and retry passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
