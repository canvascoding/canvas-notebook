import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StudioScope } from '@/app/lib/integrations/studio-scope';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const writablePermissions = {
  canRead: true,
  canWrite: true,
  canDelete: true,
  canCreatePublicLinks: false,
  canManageWorkspace: false,
  canRunAgent: false,
};

function workspace(workspaceId: string, rootPath: string): WorkspaceContext {
  return {
    workspaceId,
    workspaceType: 'project',
    rootPath,
    permissions: writablePermissions,
    legacy: false,
  };
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-aspect-ratio-security-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATA_ROOT = tempRoot;

  try {
    const attackerRoot = path.join(tempRoot, 'attacker');
    const victimRoot = path.join(tempRoot, 'victim');
    await Promise.all([
      fs.mkdir(attackerRoot, { recursive: true }),
      fs.mkdir(victimRoot, { recursive: true }),
    ]);
    await fs.writeFile(path.join(attackerRoot, 'image.png'), 'attacker-original');
    await fs.writeFile(path.join(victimRoot, 'image.png'), 'victim-original');

    const attackerWorkspace = workspace('workspace-attacker', attackerRoot);
    const scope: StudioScope = {
      actorUserId: 'user-attacker',
      organizationId: 'organization-attacker',
      customerId: null,
      projectId: null,
      workspaceId: attackerWorkspace.workspaceId,
      storage: {
        organizationId: 'organization-attacker',
        workspaceId: attackerWorkspace.workspaceId,
      },
    };

    const { overwriteAspectRatioSource } = await import(
      '@/app/lib/integrations/studio-aspect-ratio-overwrite'
    );

    await assert.rejects(
      () => overwriteAspectRatioSource(
        '/api/media/image.png?workspaceId=workspace-victim',
        Buffer.from('attacker-edit'),
        scope,
        { workspace: attackerWorkspace },
      ),
      /different workspace/u,
    );
    assert.equal(
      await fs.readFile(path.join(victimRoot, 'image.png'), 'utf8'),
      'victim-original',
      'A mismatched workspace reference must not modify the victim file.',
    );

    await overwriteAspectRatioSource(
      '/api/media/image.png?workspaceId=workspace-attacker',
      Buffer.from('attacker-edit'),
      scope,
      { workspace: attackerWorkspace },
    );
    assert.equal(
      await fs.readFile(path.join(attackerRoot, 'image.png'), 'utf8'),
      'attacker-edit',
      'The authorized overwrite flow must remain functional.',
    );

    const readOnlyWorkspace = workspace('workspace-read-only', attackerRoot);
    readOnlyWorkspace.permissions = { ...writablePermissions, canWrite: false };
    await assert.rejects(
      () => overwriteAspectRatioSource(
        '/api/media/image.png?workspaceId=workspace-read-only',
        Buffer.from('should-not-write'),
        scope,
        { workspace: readOnlyWorkspace },
      ),
      /not writable/u,
    );
    assert.equal(await fs.readFile(path.join(attackerRoot, 'image.png'), 'utf8'), 'attacker-edit');

    console.log('studio-aspect-ratio-security-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
