import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditEvents, canvasOrganizationSettings, canvasWorkspaces, user } from '../app/lib/db/schema';
import { createPiTestDatabase } from './helpers/pi-test-database';

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-trash-'));
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  const workspaceRelativePath = 'workspaces/personal/agent-trash/files';
  const workspaceRoot = path.join(dataDir, workspaceRelativePath);
  await fs.mkdir(workspaceRoot, { recursive: true });

  const testDatabase = await createPiTestDatabase();
  const now = new Date();
  await testDatabase.db.insert(user).values({
    id: 'agent-trash-user', name: 'Agent Trash User', email: 'agent-trash@example.test',
    emailVerified: true, createdAt: now, updatedAt: now,
  });
  await testDatabase.db.insert(canvasOrganizationSettings).values({
    organizationId: 'agent-trash-org', ownerUserId: 'agent-trash-user',
    createdAt: now, updatedAt: now,
  });
  await testDatabase.db.insert(canvasWorkspaces).values({
    id: 'agent-trash-test', organizationId: 'agent-trash-org', type: 'personal',
    ownerUserId: 'agent-trash-user', rootRelativePath: workspaceRelativePath,
    displayName: 'Agent Trash Test', createdAt: now, updatedAt: now,
  });
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  let failTrashFor: string | null = null;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDatabase;
    if (request === 'server-only') return {};
    if (request === '@/app/lib/filesystem/workspace-trash') {
      const real = originalLoad(request, parent, isMain) as typeof import('../app/lib/filesystem/workspace-trash');
      return {
        ...real,
        trashWorkspacePaths: async (params: Parameters<typeof real.trashWorkspacePaths>[0]) =>
          params.paths[0] === failTrashFor
            ? { trashed: [], failed: [{ path: params.paths[0], error: 'Simulated trash storage failure' }] }
            : real.trashWorkspacePaths(params),
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { deleteAgentPaths } = await import('../app/lib/pi/agent-file-operations');
    const { formatPathOperationResult } = await import('../app/lib/pi/tool-file-formatters');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { restoreWorkspaceTrashEntry } = await import('../app/lib/filesystem/workspace-trash');
    const { restoreFileCollaborationPath } = await import('../app/lib/files/collaboration-policy');
    const workspace = {
      workspaceId: 'agent-trash-test', workspaceType: 'personal' as const,
      rootPath: workspaceRoot, rootRelativePath: workspaceRelativePath,
      organizationId: 'agent-trash-org', ownerUserId: 'agent-trash-user', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true },
    };
    const context = {
      userId: 'agent-trash-user', sessionId: 'agent-trash-session', agentId: 'agent-trash-agent',
      workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
      workspaceName: 'Agent Trash Test', organizationId: 'agent-trash-org', customerId: null, projectId: null,
      workspaceRoot, workspaceRootRelativePath: workspaceRelativePath,
      canWrite: true, canDelete: true, canShare: false, legacy: false,
    };

    const markdown = Buffer.from(`# Large document\n${'Markdown content with links [ref](./target.md).\n'.repeat(30_000)}`);
    const binary = Buffer.alloc(9 * 1024 * 1024, 0x8f);
    assert(markdown.length > 1024 * 1024);
    await fs.writeFile(path.join(workspaceRoot, 'large.md'), markdown);
    await fs.writeFile(path.join(workspaceRoot, 'large.bin'), binary);

    const result = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['large.md', 'large.bin'] }));
    assert.equal(result.changed, true);
    assert.equal(result.verified, true);
    assert.deepEqual(result.failedPaths, []);
    assert.equal(result.trashEntries?.length, 2);
    assert.equal(result.bytes, markdown.length + binary.length);
    for (const name of ['large.md', 'large.bin']) {
      await assert.rejects(fs.stat(path.join(workspaceRoot, name)), { code: 'ENOENT' });
      const entry: { id: string; originalPath: string; expiresAt: string } | undefined = result.trashEntries!.find((item) => item.originalPath === name);
      assert(entry);
      const restored = await restoreWorkspaceTrashEntry({ workspace, entryId: entry.id, restoredByUserId: context.userId });
      await restoreFileCollaborationPath({ workspace, path: restored.originalPath, trashEntryId: entry.id });
      const actual = await fs.readFile(path.join(workspaceRoot, name));
      assert.equal(sha256(actual), sha256(name === 'large.md' ? markdown : binary));
    }

    await fs.mkdir(path.join(workspaceRoot, 'nested'));
    await fs.writeFile(path.join(workspaceRoot, 'nested', 'child.txt'), 'child');
    const directory = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['nested'], recursive: true }));
    assert.equal(directory.trashEntries?.length, 1);
    assert.equal(directory.verified, true);
    const restoredDirectory = await restoreWorkspaceTrashEntry({ workspace, entryId: directory.trashEntries![0].id, restoredByUserId: context.userId });
    await restoreFileCollaborationPath({ workspace, path: restoredDirectory.originalPath, trashEntryId: directory.trashEntries![0].id });
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'nested', 'child.txt'), 'utf8'), 'child');

    await fs.writeFile(path.join(workspaceRoot, 'first-long-name.md'), 'first');
    await fs.writeFile(path.join(workspaceRoot, 'blocked.md'), 'blocked');
    failTrashFor = 'blocked.md';
    const partial = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['first-long-name.md', 'blocked.md'] }));
    failTrashFor = null;
    assert.equal(partial.changed, true);
    assert.equal(partial.verified, false);
    assert.equal(partial.trashEntries?.length, 1);
    assert.deepEqual(partial.failedPaths, [{ path: 'blocked.md', error: 'Simulated trash storage failure' }]);
    assert.match(formatPathOperationResult(partial), /Failed paths: 1/);
    assert.match(formatPathOperationResult(partial), /Trash entry: first-long-name\.md/);
    assert.equal(partial.entries.find((entry) => entry.sourcePath === 'first-long-name.md')?.changed, true);
    assert.equal(partial.entries.find((entry) => entry.sourcePath === 'blocked.md')?.changed, false);
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'first-long-name.md')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'blocked.md'), 'utf8'), 'blocked');
    const audits = await testDatabase.db.select().from(auditEvents);
    assert(audits.some((entry) => entry.action === 'agent_path.delete_path' && entry.status === 'failure'));

    console.log('Agent workspace trash: large Markdown, binary, directory, hash-identical restore, and audited partial failure passed.');
  } finally {
    moduleInternals._load = originalLoad;
    await testDatabase.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
