import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { WorkspaceDocumentLinkIndex, WorkspaceLinkReadEdge } from '../app/lib/markdown/workspace-document-link-index-contract';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-document-relations-'));
  const workspaceRoot = path.join(dataDir, 'workspace');
  const outsidePath = path.join(dataDir, 'outside.md');
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.DATABASE_PROVIDER = 'postgres';

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  const originalReadFile = fs.readFile;
  let authorityIndex: WorkspaceDocumentLinkIndex | null = null;
  let protectToolReads = false;
  let authorityReads = 0, directMarkdownReads = 0, legacyIndexReads = 0, serializerImports = 0;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    const modulePath = request.replace(/\\/gu, '/').replace(/\.[cm]?[jt]s$/u, '');
    if (modulePath.endsWith('/markdown/workspace-document-link-index')) return {
      readWorkspaceDocumentLinkIndex: async (workspace: { workspaceId: string; rootPath: string }) => {
        authorityReads++;
        assert.equal(workspace.workspaceId, 'relations-workspace');
        assert.equal(workspace.rootPath, workspaceRoot);
        assert.ok(authorityIndex, 'the authority adapter must have an explicit read snapshot');
        return structuredClone(authorityIndex);
      },
    };
    if (protectToolReads && modulePath.endsWith('/markdown/workspace-link-index')) {
      legacyIndexReads++;
      throw new Error('The relations tool must use the native-and-physical authority reader');
    }
    if (protectToolReads && modulePath.endsWith('/collaboration/markdown-state')) {
      serializerImports++;
      throw new Error('The relations tool must not serialize native state to Markdown');
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    await fs.mkdir(path.join(workspaceRoot, 'Atlas'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, 'Inbox'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'Atlas', 'Home.md'), [
      '---',
      'title: Home',
      'tags: [project/atlas]',
      '---',
      '',
      '# Home',
      '',
      '[[Plan#Outcome|Roadmap]]',
      '[[Missing Note]]',
    ].join('\n'));
    await fs.writeFile(path.join(workspaceRoot, 'Atlas', 'Plan.md'), [
      '---',
      'title: Plan',
      'tags: [project/atlas]',
      '---',
      '',
      '# Plan',
      '',
      '## Outcome',
      '',
      '[[Home]]',
      '[[Research]]',
    ].join('\n'));
    await fs.writeFile(path.join(workspaceRoot, 'Atlas', 'Research.md'), '# Research');
    await fs.writeFile(path.join(workspaceRoot, 'Atlas', 'Brief.md'), [
      '---',
      'title: Brief',
      'tags: [project/atlas]',
      '---',
      '',
      '# Brief',
    ].join('\n'));
    await fs.writeFile(path.join(workspaceRoot, 'Inbox', 'Source.md'), '# Source\n\n[[Atlas/Home]]');
    await fs.writeFile(outsidePath, '# Outside');

    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { buildWorkspaceLinkIndex } = await import('../app/lib/markdown/workspace-link-index');
    const workspace = {
      workspaceId: 'relations-workspace',
      workspaceType: 'personal' as const,
      rootPath: workspaceRoot,
      displayName: 'Relations Workspace',
      ownerUserId: 'relations-user',
      permissions: {
        canRead: true,
        canWrite: true,
        canDelete: true,
        canCreatePublicLinks: false,
        canManageWorkspace: false,
        canRunAgent: true,
      },
      legacy: false,
    };
    const executionContext = {
      userId: 'relations-user',
      sessionId: 'relations-session',
      agentId: 'canvas-agent',
      workspaceId: workspace.workspaceId,
      workspaceType: workspace.workspaceType,
      workspaceName: workspace.displayName,
      organizationId: null,
      customerId: null,
      projectId: null,
      workspaceRoot,
      workspaceRootRelativePath: null,
      canWrite: true,
      canDelete: true,
      canShare: false,
      legacy: false,
    };

    const overriddenIndex = await buildWorkspaceLinkIndex(
      { workspace },
      { contentOverrides: new Map([[
        'Atlas/Home.md',
        '---\ntitle: Home\ntags: [project/atlas]\n---\n\n# Home\n\n[[Research]]',
      ]]) },
    );
    assert.deepEqual(
      overriddenIndex.edges
        .filter((edge) => edge.sourcePath === 'Atlas/Home.md')
        .map((edge) => edge.targetPath),
      ['Atlas/Research.md'],
    );

    const physicalIndex = await buildWorkspaceLinkIndex({ workspace });
    const physicalEdges: WorkspaceLinkReadEdge[] = physicalIndex.edges.map(edge => ({
      alias: edge.alias, blockId: edge.blockId, candidates: [...edge.candidates], embed: edge.embed,
      heading: edge.heading, id: edge.id, kind: edge.kind, syntax: edge.syntax, sourcePath: edge.sourcePath,
      targetLiteral: edge.targetLiteral, targetText: edge.targetText, status: edge.status, targetPath: edge.targetPath,
      sourcePreview: { kind: 'physical-markdown', focusOffset: edge.start },
    }));
    authorityIndex = {
      indexVersion: 2, workspaceId: workspace.workspaceId,
      documents: physicalIndex.documents, edges: physicalEdges,
      backlinks: Object.fromEntries(physicalIndex.targetPaths.map(target => [target,
        physicalEdges.filter(edge => edge.targetPath === target)])),
      brokenLinks: physicalEdges.filter(edge => !['resolved', 'external', 'anchor-only'].includes(edge.status)),
      generatedAt: physicalIndex.generatedAt, targetPaths: physicalIndex.targetPaths,
      coverage: physicalIndex.coverage, omittedDocuments: physicalIndex.omittedDocuments, gaps: [],
      unevaluatedLinks: physicalIndex.unevaluatedLinks,
    };
    await import('../app/lib/pi/tool-runtime-helpers');
    protectToolReads = true;
    fs.readFile = new Proxy(originalReadFile, {
      apply(target, receiver, argumentsList: unknown[]) {
        if (typeof argumentsList[0] === 'string' && /\.(?:md|markdown)$/iu.test(argumentsList[0])) {
          directMarkdownReads++;
          throw new Error('The relations tool must not read a Markdown projection directly');
        }
        return Reflect.apply(target, receiver, argumentsList);
      },
    });
    const { createInspectDocumentRelationsTool } = await import('../app/lib/pi/document-relations-tool');
    const tool = createInspectDocumentRelationsTool();
    const result = await runWithAgentExecutionContext(executionContext, () => tool.execute('relations', {
      path: 'Atlas/Home.md',
      depth: 2,
      direction: 'both',
      limit: 10,
    }));
    const text = getText(result);
    assert.match(text, /Document relations for Home/);
    assert.match(text, /Outgoing links \(1\)/);
    assert.match(text, /Atlas\/Plan\.md/);
    assert.match(text, /Incoming links \(2\)/);
    assert.match(text, /Inbox\/Source\.md/);
    assert.match(text, /missing: Missing Note/);
    assert.match(text, /Nearby documents \(2\)/);
    assert.match(text, /Atlas\/Research\.md/);
    assert.match(text, /Atlas\/Brief\.md/);
    const details = (result as {
      details?: {
        path?: string;
        source?: string;
        coverage?: WorkspaceDocumentLinkIndex['coverage'];
        gaps?: WorkspaceDocumentLinkIndex['gaps'];
        incoming?: unknown[];
        outgoing?: unknown[];
        related?: unknown[];
      };
    }).details;
    assert.equal(details?.path, 'Atlas/Home.md');
    assert.equal(details?.source, 'native_and_physical');
    assert.equal(details?.incoming?.length, 2);
    assert.equal(details?.outgoing?.length, 1);
    assert.equal(details?.related?.length, 2);
    assert.match(text, /Index source: authoritative persisted native documents and original workspace files/u);
    assert.match(text, /Index coverage: partial/u);
    assert.deepEqual(details?.coverage, physicalIndex.coverage);
    assert.deepEqual(details?.gaps, []);
    assert.equal(authorityReads, 1);
    assert.equal((details?.outgoing?.[0] as { bidirectional?: boolean }).bidirectional, true);

    const outgoingOnly = await runWithAgentExecutionContext(executionContext, () => tool.execute('outgoing', {
      path: path.join(workspaceRoot, 'Atlas', 'Home.md'),
      direction: 'outgoing',
      includeBroken: false,
    }));
    assert.doesNotMatch(getText(outgoingOnly), /Incoming links/);
    assert.doesNotMatch(getText(outgoingOnly), /Unresolved outgoing links/);
    assert.deepEqual((outgoingOnly as { details?: { incoming?: unknown[] } }).details?.incoming, []);
    assert.equal(authorityReads, 2);

    const outsideResult = await runWithAgentExecutionContext(executionContext, () => tool.execute('outside', {
      path: outsidePath,
    }));
    assert.match(getText(outsideResult), /Error: .*workspace|Error: .*restricted/i);

    const noContextResult = await tool.execute('no-context', { path: 'Atlas/Home.md' });
    assert.match(getText(noContextResult), /active workspace session/i);
    assert.equal(authorityReads, 2, 'outside paths and absent execution context must not read workspace authority');

    const nativePath = 'Native/Only.md', nativeTarget = 'Native/Target.md', nativeIncoming = 'Native/Backlink.md';
    await assert.rejects(fs.stat(path.join(workspaceRoot, nativePath)), { code: 'ENOENT' });
    const nativeEdges: WorkspaceLinkReadEdge[] = [
      { id: 'native-outgoing', kind: 'wiki', syntax: 'wiki-link', sourcePath: nativePath,
        targetLiteral: 'Target', targetText: 'Target', alias: 'Native destination', embed: false,
        heading: null, blockId: null, candidates: [nativeTarget], status: 'resolved', targetPath: nativeTarget },
      { id: 'native-incoming', kind: 'wiki', syntax: 'wiki-link', sourcePath: nativeIncoming,
        targetLiteral: 'Only', targetText: 'Only', alias: null, embed: false,
        heading: null, blockId: null, candidates: [nativePath], status: 'resolved', targetPath: nativePath },
    ];
    const nativeIndex: WorkspaceDocumentLinkIndex = {
      indexVersion: 2, workspaceId: workspace.workspaceId, generatedAt: '2026-10-17T00:00:00.000Z',
      documents: [
        { path: nativePath, title: 'Native-only note', aliases: [], headings: [], blockIds: [], tags: [],
          nativeIdentity: { documentId: 'native-only-document', lifecycleGeneration: 7 } },
        { path: nativeTarget, title: 'Native target', aliases: [], headings: [], blockIds: [], tags: [],
          nativeIdentity: { documentId: 'native-target-document', lifecycleGeneration: 2 } },
        { path: nativeIncoming, title: 'Native backlink', aliases: [], headings: [], blockIds: [], tags: [],
          nativeIdentity: { documentId: 'native-backlink-document', lifecycleGeneration: 3 } },
      ],
      edges: nativeEdges,
      backlinks: { [nativePath]: [nativeEdges[1]], [nativeTarget]: [nativeEdges[0]], [nativeIncoming]: [] },
      brokenLinks: [], targetPaths: [nativePath, nativeTarget, nativeIncoming, 'Native/Unavailable.md'],
      coverage: { complete: false, unresolvedLinks: [], omittedSources: [
        { path: 'Native/Unavailable.md', reason: 'source-unreadable' },
      ] },
      omittedDocuments: [{ path: 'Native/Unavailable.md', reason: 'unreadable' }],
      gaps: [{ code: 'native-inventory-unreadable', path: 'Native/Unavailable.md' }],
    };
    authorityIndex = nativeIndex;
    const nativeResult = await runWithAgentExecutionContext(executionContext, () => tool.execute('native-only', {
      path: nativePath, direction: 'both', depth: 2,
    }));
    const nativeText = getText(nativeResult);
    assert.match(nativeText, /Document relations for Native-only note/u);
    assert.match(nativeText, /Outgoing links \(1\)/u);
    assert.match(nativeText, /Incoming links \(1\)/u);
    assert.match(nativeText, /Native destination/u);
    assert.match(nativeText, /Native\/Target\.md/u);
    assert.match(nativeText, /Native\/Backlink\.md/u);
    assert.match(nativeText, /Index coverage: partial/u);
    const nativeDetails = (nativeResult as { details: {
      source: string; coverage: WorkspaceDocumentLinkIndex['coverage']; gaps: WorkspaceDocumentLinkIndex['gaps'];
      document: WorkspaceDocumentLinkIndex['documents'][number]; incoming: unknown[]; outgoing: unknown[];
    } }).details;
    assert.equal(nativeDetails.source, 'native_and_physical');
    assert.deepEqual(nativeDetails.document.nativeIdentity, { documentId: 'native-only-document', lifecycleGeneration: 7 });
    assert.deepEqual(nativeDetails.coverage, nativeIndex.coverage);
    assert.deepEqual(nativeDetails.gaps, nativeIndex.gaps);
    assert.equal(nativeDetails.incoming.length, 1); assert.equal(nativeDetails.outgoing.length, 1);
    assert.doesNotMatch(JSON.stringify(nativeResult), /"(?:start|end|raw|targetRange|sourcePreview)"\s*:/u);
    assert.equal(authorityReads, 3);
    assert.equal(directMarkdownReads, 0);
    assert.equal(legacyIndexReads, 0);
    assert.equal(serializerImports, 0);

    console.log('document-relations-tool-test: ok');
  } finally {
    fs.readFile = originalReadFile;
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
