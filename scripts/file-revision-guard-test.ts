import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

function workspaceContext(params: {
  rootPath: string;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  organizationId?: string | null;
}): WorkspaceContext {
  return {
    workspaceId: params.workspaceId,
    workspaceType: params.workspaceType,
    rootPath: params.rootPath,
    rootRelativePath: path.relative(path.dirname(params.rootPath), params.rootPath),
    displayName: params.workspaceType,
    status: 'active',
    organizationId: params.organizationId ?? null,
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

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-revision-guard-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;

  try {
    const personalRoot = path.join(dataRoot, 'workspaces', 'personal', 'user-1', 'files');
    const teamRoot = path.join(dataRoot, 'workspaces', 'team', 'org-1', 'files');
    await fs.mkdir(personalRoot, { recursive: true });
    await fs.mkdir(teamRoot, { recursive: true });

    const personalWorkspace = workspaceContext({
      rootPath: personalRoot,
      workspaceId: 'ws-personal',
      workspaceType: 'personal',
      organizationId: 'org-1',
    });
    const teamWorkspace = workspaceContext({
      rootPath: teamRoot,
      workspaceId: 'ws-team',
      workspaceType: 'team',
      organizationId: 'org-1',
    });

    const {
      WorkspaceFileRevisionError,
      assertWorkspaceFileRevisionAllowed,
      getWorkspaceFileRevision,
      workspaceRequiresRevisionCheck,
    } = await import('../app/lib/files/revision-guard');
    const { writeFile } = await import('../app/lib/filesystem/workspace-files');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { editAgentFile, writeAgentTextFile } = await import('../app/lib/pi/agent-file-operations');

    await writeFile('notes.md', 'personal v1\n', { workspace: personalWorkspace });
    await assert.doesNotReject(() => assertWorkspaceFileRevisionAllowed({
      path: 'notes.md',
      options: { workspace: personalWorkspace },
      requireExpectedRevision: workspaceRequiresRevisionCheck(personalWorkspace),
    }));
    await assert.doesNotReject(() => assertWorkspaceFileRevisionAllowed({
      path: 'notes.md',
      expectedSha256: '0'.repeat(64),
      options: { workspace: personalWorkspace },
      requireExpectedRevision: workspaceRequiresRevisionCheck(personalWorkspace),
    }));

    await writeFile('team.md', 'team v1\n', { workspace: teamWorkspace });
    const teamRevision = await getWorkspaceFileRevision('team.md', { workspace: teamWorkspace });
    assert.ok(teamRevision?.sha256);

    await assert.rejects(
      () => assertWorkspaceFileRevisionAllowed({
        path: 'team.md',
        options: { workspace: teamWorkspace },
        requireExpectedRevision: workspaceRequiresRevisionCheck(teamWorkspace),
      }),
      (error) => error instanceof WorkspaceFileRevisionError && error.code === 'FILE_REVISION_REQUIRED' && error.status === 428,
    );

    await assert.rejects(
      () => assertWorkspaceFileRevisionAllowed({
        path: 'team.md',
        expectedSha256: '0'.repeat(64),
        options: { workspace: teamWorkspace },
        requireExpectedRevision: workspaceRequiresRevisionCheck(teamWorkspace),
      }),
      (error) => error instanceof WorkspaceFileRevisionError && error.code === 'FILE_REVISION_CONFLICT' && error.status === 409,
    );

    await assert.doesNotReject(() => assertWorkspaceFileRevisionAllowed({
      path: 'team.md',
      expectedSha256: teamRevision.sha256,
      options: { workspace: teamWorkspace },
      requireExpectedRevision: workspaceRequiresRevisionCheck(teamWorkspace),
    }));

    const agentContext = {
      userId: 'user-1',
      sessionId: 'session-1',
      agentId: 'canvas-agent',
      workspaceId: teamWorkspace.workspaceId,
      workspaceType: teamWorkspace.workspaceType,
      workspaceName: teamWorkspace.displayName ?? null,
      organizationId: teamWorkspace.organizationId ?? null,
      customerId: null,
      projectId: null,
      workspaceRoot: teamWorkspace.rootPath,
      workspaceRootRelativePath: teamWorkspace.rootRelativePath ?? null,
      canWrite: true,
      canShare: true,
      legacy: false,
    };

    await runWithAgentExecutionContext(agentContext, async () => {
      const created = await writeAgentTextFile({
        path: 'agent-created.md',
        content: 'agent v1\n',
      });
      assert.equal(created.changed, true);

      await assert.rejects(
        () => writeAgentTextFile({
          path: 'agent-created.md',
          content: 'agent v2\n',
        }),
        /existing shared workspace files require expectedSha256/i,
      );

      const updated = await writeAgentTextFile({
        path: 'agent-created.md',
        content: 'agent v2\n',
        expectedSha256: `sha256:${created.afterSha256.toUpperCase()}`,
      });
      assert.equal(updated.changed, true);

      const edited = await editAgentFile({
        path: 'agent-created.md',
        oldText: 'agent v2\n',
        newText: 'agent v3\n',
        expectedSha256: updated.afterSha256,
      });
      assert.equal(edited.changed, true);
    });

    console.log('file-revision-guard-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
