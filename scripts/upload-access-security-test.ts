import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-upload-access-security-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATA_ROOT = tempRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { saveUploadBuffer } = await import('@/app/lib/filesystem/upload-handler');
    const {
      getUploadAccessGrant,
      isUploadAccessAllowed,
    } = await import('@/app/lib/files/upload-access-store');
    const { normalizePiMessagesForLlm } = await import('@/app/lib/pi/message-normalization');

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const saved = await saveUploadBuffer(png, 'private.png', 'image/png', {
      ownerUserId: 'user-owner',
    });
    const grant = await getUploadAccessGrant(saved.id);
    assert(grant);
    assert.equal(grant.ownerUserId, 'user-owner');
    assert.equal(grant.workspaceId, null);
    assert.equal(isUploadAccessAllowed(grant, { userId: 'user-owner' }), true);
    assert.equal(isUploadAccessAllowed(grant, { userId: 'user-attacker' }), false);
    assert.equal(
      isUploadAccessAllowed({ ...grant, workspaceId: 'workspace-owner' }, {
        userId: 'workspace-member',
        workspaceId: 'workspace-owner',
      }),
      true,
    );

    const { canSessionReadUpload } = await import('@/app/lib/files/upload-access-authorization');
    const ownerSession = { user: { id: 'user-owner', email: 'owner@example.test', role: 'member' } };
    const attackerSession = { user: { id: 'user-attacker', email: 'attacker@example.test', role: 'member' } };
    assert.equal(await canSessionReadUpload(ownerSession as never, saved.id), true);
    assert.equal(await canSessionReadUpload(attackerSession as never, saved.id), false);

    const ownerMessages = await normalizePiMessagesForLlm([{
      role: 'user',
      content: [{
        type: 'image',
        data: `/api/files/${encodeURIComponent(saved.id)}`,
        mimeType: 'image/png',
      }],
      timestamp: Date.now(),
    }], {
      uploadOwnerUserId: 'user-owner',
    });
    assert.equal(Array.isArray(ownerMessages[0].content), true);

    await assert.rejects(
      () => normalizePiMessagesForLlm([{
        role: 'user',
        content: [{
          type: 'image',
          data: `/api/files/${encodeURIComponent(saved.id)}`,
          mimeType: 'image/png',
        }],
        timestamp: Date.now(),
      }], {
        uploadOwnerUserId: 'user-attacker',
        uploadWorkspaceId: 'workspace-attacker',
      }),
      /not available to this user/u,
    );

    const storedPath = path.join(tempRoot, 'user-uploads', saved.category, saved.id);
    assert.deepEqual(await fs.readFile(storedPath), png, 'Denied access must not modify the stored upload.');

    console.log('upload-access-security-test: ok');
  } finally {
    const { closeDatabaseConnections } = await import('@/app/lib/db');
    await closeDatabaseConnections();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
