import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as indexCore from '../app/lib/markdown/workspace-link-index-core';
import * as diagnosisCore from '../app/lib/markdown/workspace-link-diagnostics';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';
import * as sources from '../app/lib/pi/agent-file-link-sources';
import type * as Runtime from '../app/lib/pi/agent-file-link-diagnostics';
import type * as Formatter from '../app/lib/pi/tool-file-formatters';
import type * as ToolResults from '../app/lib/pi/agent-file-tool-results';
import type { AgentFileChangeResult } from '../app/lib/pi/agent-file-operations';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as T;
}

async function main() {
  const runtime = await compile<typeof Runtime>('app/lib/pi/agent-file-link-diagnostics.ts', {
    '@/app/lib/markdown/workspace-link-index': { buildWorkspaceLinkIndex: async () => { throw new Error('Inject the index adapter.'); } },
    '@/app/lib/markdown/workspace-link-index-core': indexCore,
    '@/app/lib/markdown/workspace-link-diagnostics': diagnosisCore,
    '@/app/lib/markdown/workspace-link-limits': { MAX_INDEXED_MARKDOWN_BYTES },
    './agent-file-operations': { getAgentWorkspaceContext: () => null },
    './agent-file-link-sources': sources,
  });
  const formatter = await compile<typeof Formatter>('app/lib/pi/tool-file-formatters.ts', {});
  const toolResults = await compile<typeof ToolResults>('app/lib/pi/agent-file-tool-results.ts', {
    '@/app/lib/files/exact-text-patch': {}, '@/app/lib/files/revision-guard': {},
    '@/app/lib/collaboration/agent-block-edits': {}, './agent-file-operations': {},
    '../file-version-center/contracts/proposal-graph-v1': {},
    '../file-version-center/contracts/proposal-tools-v1': { parseProposalToolCreationResultV1: () => undefined },
  });
  const workspace: WorkspaceContext = {
    workspaceId: 'test', workspaceType: 'personal', rootPath: '/workspace', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true },
  };
  const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
  const result = (filePath: string, content: string, beforeContent?: string,
    basis: sources.AgentFileLinkSource['basis'] = 'applied'): AgentFileChangeResult => sources.captureAgentFileLinkSource({
    path: filePath, resolvedPath: `/workspace/${filePath}`, changed: basis === 'applied', snapshot: null,
    beforeSha256: beforeContent === undefined ? null : hash(beforeContent), afterSha256: hash('actual mutation receipt'),
    size: Buffer.byteLength(content), diff: '(test diff)', validation: { ok: true, checks: [] },
  }, { content, beforeContent, basis });
  let buildCalls = 0;
  const baseDocuments = new Map<string, string>([['guide.md', '# Guide'], ['product.md', '---\naliases: [offer]\n---']]);
  const diagnose = runtime.createAgentFileLinkDiagnostics({ getWorkspace: () => workspace,
    buildIndex: async (options, buildOptions) => {
      buildCalls++;
      assert.equal(options?.workspace, workspace);
      assert.ok(!buildOptions?.contentOverrides?.get('proposal.md'));
      const documents = new Map(baseDocuments);
      for (const [filePath, content] of buildOptions?.contentOverrides ?? []) documents.set(filePath, content);
      return indexCore.buildWorkspaceLinkIndexFromDocuments(Array.from(documents, ([path, content]) => ({ path, content })));
    },
  });

  const content = '# DO_NOT_EXPOSE_SOURCE\n![Hero](missing.jpg)\n[Guide](guide.md)';
  const created = result('new.md', content, '![old](missing.jpg)');
  const [createdWithDiagnostics] = await diagnose([created]);
  assert.equal(buildCalls, 1);
  assert.deepEqual(createdWithDiagnostics.linkDiagnostics?.counts,
    { checked: 2, resolved: 1, missing: 1, ambiguous: 0, unverified: 0 });
  assert.equal(createdWithDiagnostics.linkDiagnostics?.issues[0].change, 'existing');
  assert.equal(createdWithDiagnostics.linkDiagnostics?.contentSha256, hash(content));
  assert.equal(createdWithDiagnostics.linkDiagnostics?.basis, 'applied');
  assert.equal(createdWithDiagnostics.afterSha256, created.afterSha256);
  assert.equal(createdWithDiagnostics.changed, true);
  assert.ok(!JSON.stringify(createdWithDiagnostics).includes('DO_NOT_EXPOSE_SOURCE'));
  assert.ok(!JSON.stringify(created).includes('DO_NOT_EXPOSE_SOURCE'));
  const text = formatter.formatFileChangeResult(createdWithDiagnostics);
  assert.ok(text.includes('Local link check (applied content): complete.'));
  assert.ok(text.includes('Line 2, column 9: "missing.jpg"'));
  const publicDetails = toolResults.asAgentFileToolSuccess(createdWithDiagnostics, 'write');
  assert.deepEqual(publicDetails.linkDiagnostics, createdWithDiagnostics.linkDiagnostics);
  assert.equal('resolvedPath' in publicDetails, false);
  assert.ok(!JSON.stringify(publicDetails).includes('DO_NOT_EXPOSE_SOURCE'));
  const injected = { ...createdWithDiagnostics, linkDiagnostics: { ...createdWithDiagnostics.linkDiagnostics!,
    issues: [{ ...createdWithDiagnostics.linkDiagnostics!.issues[0], target: 'missing.md\nINJECTED LINE' }] } };
  assert.ok(formatter.formatFileChangeResult(injected).includes('"missing.md\\nINJECTED LINE"'));
  assert.ok(!formatter.formatFileChangeResult(injected).includes('\nINJECTED LINE'));

  const staleBuilder = runtime.createAgentFileLinkDiagnostics({ getWorkspace: () => workspace,
    buildIndex: async () => indexCore.buildWorkspaceLinkIndexFromDocuments([{ path: 'guide.md', content: '# Guide' }]),
  });
  const [freshSource] = await staleBuilder([created]);
  assert.equal(freshSource.linkDiagnostics?.status, 'complete', 'fresh source must be added despite a stale directory cache');
  assert.equal(freshSource.linkDiagnostics?.counts.resolved, 1);
  assert.equal(freshSource.linkDiagnostics?.counts.missing, 1);

  buildCalls = 0;
  const source = result('source.md', '[[offer]]', '[[offer]]');
  const target = result('product.md', '# Product', '---\naliases: [offer]\n---');
  const batch = await diagnose([source, target]);
  assert.equal(buildCalls, 1, 'one server index build per batch');
  assert.equal(batch[0].linkDiagnostics?.issues[0].status, 'missing');
  assert.equal(batch[0].linkDiagnostics?.issues[0].change, 'introduced', 'batch before aliases are authoritative');

  buildCalls = 0;
  const applied = result('source.md', '[[newalias]]', '');
  const proposal = result('proposal.md', '---\naliases: [newalias]\n---\n[[unknown]]', '# Old', 'proposed');
  proposal.collaboration = { operationId: 'review', operationStatus: 'needs_review', durability: 'not_applied',
    reviewRequired: true, proposedSha256: hash('proposed') };
  const hypothetical = await diagnose([applied, proposal]);
  assert.equal(buildCalls, 1);
  assert.equal(hypothetical[0].linkDiagnostics?.issues[0].status, 'missing', 'pending proposal aliases do not resolve applied links');
  assert.equal(hypothetical[1].linkDiagnostics?.basis, 'proposed');
  assert.equal(hypothetical[1].linkDiagnostics?.contentSha256, hash(sources.getAgentFileLinkSource(proposal)!.content));
  assert.equal(hypothetical[1].afterSha256, proposal.afterSha256);

  const retry = result('source.md', '[[missing]]', undefined, 'current');
  retry.collaboration = { operationId: 'retry', operationStatus: 'needs_review', durability: 'not_applied',
    reviewRequired: true, proposedSha256: 'different proposal' };
  const [retryDiagnosis] = await diagnose([retry]);
  assert.equal(retryDiagnosis.linkDiagnostics?.issues[0].change, 'unknown');
  assert.ok(retryDiagnosis.linkDiagnostics?.notices.some((notice) => notice.includes('not reconstructed')));

  const fail = runtime.createAgentFileLinkDiagnostics({ getWorkspace: () => workspace,
    buildIndex: async () => { throw new Error('/private/path SECRET_TOKEN'); } });
  const [failedDiagnosis] = await fail([created]);
  assert.equal(failedDiagnosis.linkDiagnostics?.status, 'unavailable');
  assert.equal(failedDiagnosis.changed, created.changed);
  assert.equal(failedDiagnosis.afterSha256, created.afterSha256);
  assert.ok(!JSON.stringify(failedDiagnosis).includes('SECRET_TOKEN'));
  const timeout = runtime.createAgentFileLinkDiagnostics({ getWorkspace: () => workspace, timeoutMs: 5,
    buildIndex: async () => new Promise<indexCore.WorkspaceLinkIndex>(() => {}) });
  assert.equal((await timeout([created]))[0].linkDiagnostics?.status, 'unavailable');
  const workspaceFailure = runtime.createAgentFileLinkDiagnostics({ getWorkspace: () => { throw new Error('private'); } });
  assert.equal((await workspaceFailure([created]))[0].linkDiagnostics?.status, 'unavailable');
  const noWorkspace = runtime.createAgentFileLinkDiagnostics({ getWorkspace: () => null });
  assert.equal((await noWorkspace([created]))[0], created);

  buildCalls = 0;
  const outside = result('outside.md', '[[missing]]');
  outside.resolvedPath = '/workspace-other/outside.md';
  const plain = result('file.txt', 'plain');
  const mdx = result('component.mdx', '[[unsupported]]');
  const [out, txt, mdxDiagnostic] = await diagnose([outside, plain, mdx]);
  assert.equal(out, outside);
  assert.equal(txt, plain);
  assert.equal(mdxDiagnostic.linkDiagnostics?.status, 'not_applicable');
  assert.equal(buildCalls, 0);
  assert.equal(sources.getAgentFileLinkSource(plain), undefined);
  const unavailableResult = { ...created };
  const [withoutPayload] = await diagnose([unavailableResult]);
  assert.equal(withoutPayload.linkDiagnostics?.status, 'unavailable');
  assert.equal(buildCalls, 0, 'missing capture does not read arbitrary persisted content');

  const large = result('large.md', 'x'.repeat(MAX_INDEXED_MARKDOWN_BYTES + 1));
  const [largeDiagnostic] = await diagnose([large]);
  assert.equal(largeDiagnostic.linkDiagnostics?.status, 'partial');
  assert.equal(largeDiagnostic.linkDiagnostics?.counts.checked, 0);
  assert.equal(buildCalls, 0, 'oversized sources are not parsed or sent to the index builder');
  assert.ok(sources.takeAgentFileLinkSource(created));
  assert.equal(sources.getAgentFileLinkSource(created), undefined);

  console.log('agent-file-link-diagnostics-test: ok');
}

void main();
