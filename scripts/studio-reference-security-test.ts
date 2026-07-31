import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

    const encodedTraversal = decodeURIComponent(
      '..%2F..%2F..%2Fworkspace-b%2Fassets%2Freferences%2F' + victimReference.id,
    );
    assert.equal(isValidStudioReferenceId(encodedTraversal), false);
    await assert.rejects(
      () => readStudioReferenceFile(attackerScope, encodedTraversal),
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

    console.log('studio-reference-security-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
