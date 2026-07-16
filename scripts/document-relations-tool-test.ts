import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

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
  process.env.DATABASE_PROVIDER = 'sqlite';

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
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
    const { createInspectDocumentRelationsTool } = await import('../app/lib/pi/document-relations-tool');
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
        incoming?: unknown[];
        outgoing?: unknown[];
        related?: unknown[];
      };
    }).details;
    assert.equal(details?.path, 'Atlas/Home.md');
    assert.equal(details?.source, 'workspace_files');
    assert.equal(details?.incoming?.length, 2);
    assert.equal(details?.outgoing?.length, 1);
    assert.equal(details?.related?.length, 2);

    const outgoingOnly = await runWithAgentExecutionContext(executionContext, () => tool.execute('outgoing', {
      path: path.join(workspaceRoot, 'Atlas', 'Home.md'),
      direction: 'outgoing',
      includeBroken: false,
    }));
    assert.doesNotMatch(getText(outgoingOnly), /Incoming links/);
    assert.doesNotMatch(getText(outgoingOnly), /Unresolved outgoing links/);
    assert.deepEqual((outgoingOnly as { details?: { incoming?: unknown[] } }).details?.incoming, []);

    const outsideResult = await runWithAgentExecutionContext(executionContext, () => tool.execute('outside', {
      path: outsidePath,
    }));
    assert.match(getText(outsideResult), /Error: .*workspace|Error: .*restricted/i);

    const noContextResult = await tool.execute('no-context', { path: 'Atlas/Home.md' });
    assert.match(getText(noContextResult), /active workspace session/i);

    console.log('document-relations-tool-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
