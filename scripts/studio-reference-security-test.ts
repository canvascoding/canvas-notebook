import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-reference-security-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATA_ROOT = tempRoot;

  try {
    const {
      generateStudioReferencePath,
      isValidStudioReferenceId,
      readStudioReferenceFile,
      writeStudioReferenceFile,
    } = await import('@/app/lib/integrations/studio-workspace');

    const attackerScope = { organizationId: 'organization-a', workspaceId: 'workspace-a' };
    const victimScope = { organizationId: 'organization-b', workspaceId: 'workspace-b' };
    const attackerReference = generateStudioReferencePath(attackerScope, 'attacker.png');
    const victimReference = generateStudioReferencePath(victimScope, 'victim.png');

    assert.equal(isValidStudioReferenceId(attackerReference.id), true);
    assert.equal(isValidStudioReferenceId(victimReference.id), true);

    await writeStudioReferenceFile(attackerScope, attackerReference.id, Buffer.from('attacker-reference'));
    await writeStudioReferenceFile(victimScope, victimReference.id, Buffer.from('victim-sentinel'));
    assert.equal(
      (await readStudioReferenceFile(attackerScope, attackerReference.id)).toString('utf8'),
      'attacker-reference',
      'Authorized reference reads must remain functional.',
    );

    const encodedTraversal =
      '..%2F..%2F..%2Fworkspace-b%2Fassets%2Freferences%2F' + victimReference.id;
    const decodedTraversal = decodeURIComponent(encodedTraversal);
    assert.equal(isValidStudioReferenceId(decodedTraversal), false);
    await assert.rejects(
      () => readStudioReferenceFile(attackerScope, decodedTraversal),
      /Invalid Studio reference id/u,
    );
    assert.equal(
      (await readStudioReferenceFile(victimScope, victimReference.id)).toString('utf8'),
      'victim-sentinel',
    );

    const attackerReferenceRoot = path.join(
      tempRoot,
      'studio/organizations/organization-a/workspaces/workspace-a/assets/references',
    );
    const linkedId = generateStudioReferencePath(attackerScope, 'linked.png').id;
    await fs.symlink(
      path.join(
        tempRoot,
        'studio/organizations/organization-b/workspaces/workspace-b/assets/references',
        victimReference.id,
      ),
      path.join(attackerReferenceRoot, linkedId),
    );
    await assert.rejects(
      () => readStudioReferenceFile(attackerScope, linkedId),
      /Invalid Studio reference storage path/u,
    );

    const moduleInternals = Module as typeof Module & { _load: LoadFn };
    const originalLoad = moduleInternals._load;
    moduleInternals._load = (request, parent, isMain) => {
      if (request === 'server-only') return {};
      if (request === '@/app/lib/auth' || request.endsWith('/app/lib/auth')) {
        return {
          auth: {
            api: {
              getSession: async () => ({ user: { id: 'user-attacker' } }),
            },
          },
        };
      }
      if (
        request === '@/app/lib/integrations/studio-request-scope'
        || request.endsWith('/app/lib/integrations/studio-request-scope')
      ) {
        return {
          requireStudioRequestScope: async () => ({
            scope: { storage: attackerScope },
          }),
        };
      }
      return originalLoad(request, parent, isMain);
    };
    try {
      const route = await import('../app/api/studio/references/[id]/route');
      const response = await route.GET(
        new NextRequest(`http://localhost:3000/api/studio/references/${encodedTraversal}`),
        { params: Promise.resolve({ id: decodedTraversal }) },
      );
      assert.equal(
        response.status,
        400,
        'The API route must reject a URL-decoded traversal ID before reading storage.',
      );
    } finally {
      moduleInternals._load = originalLoad;
    }

    console.log('studio-reference-security-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
