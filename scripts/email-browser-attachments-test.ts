import assert from 'node:assert/strict';
import Module from 'node:module';
const calls: string[] = [];
let denyWorkspace = false;
const saved: Array<{ ownerUserId: string; workspaceId: string }> = [];
const internal = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const original = internal._load;
internal._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/pi/agent-execution-context') return { getAgentExecutionContext: () => { throw new Error('Browser must not use agent context'); } };
  if (request.includes('/pi/session-workspace-context')) return { resolveAgentSessionWorkspaceForUser: async (input: { userId: string; workspaceId: string; permissions: string[] }) => {
    assert.equal(input.userId, 'actor'); assert.deepEqual(input.permissions, ['canRead']); calls.push(`authorize:${input.workspaceId}`);
    if (denyWorkspace || input.workspaceId !== 'source-workspace') throw new Error('denied');
    return { workspaceId: input.workspaceId, actor: { userId: input.userId }, permissions: { canRead: true } };
  } };
  if (request.includes('/files/upload-access-store')) return { getUploadAccessGrant: async (id: string) => { calls.push(`grant:${id}`); return id === 'own' ? { ownerUserId: 'actor' } : id === 'shared' ? { ownerUserId: 'teammate', workspaceId: 'source-workspace' } : { ownerUserId: 'mailbox-owner', workspaceId: null }; } };
  if (request === '@/app/lib/filesystem/workspace-files') return {
    getFileStats: async (_path: string, options: { workspace: { workspaceId: string; actor: { userId: string } } }) => { assert.equal(options.workspace.workspaceId, 'source-workspace'); assert.equal(options.workspace.actor.userId, 'actor'); calls.push('stats'); return { isFile: true, size: 7 }; },
    readFile: async (_path: string, options: { workspace: { actor: { userId: string } } }) => { assert.equal(options.workspace.actor.userId, 'actor'); calls.push('read-workspace'); return Buffer.from('content'); },
  };
  if (request === '@/app/lib/filesystem/upload-handler') return {
    getFileInfo: async () => ({ size: 7, originalName: 'upload.txt', mimeType: 'text/plain' }),
    readFile: async () => { calls.push('read-upload'); return Buffer.from('content'); },
    saveUploadBuffer: async (buffer: Buffer, _name: string, _mime: string, options: { ownerUserId: string; workspaceId: string }) => { assert.equal(buffer.toString(), 'content'); saved.push(options); return { id: `snapshot-${saved.length}` }; },
  };
  return original(request, parent, isMain);
};
async function main() {
  try {
    const { snapshotBrowserEmailAttachments, BrowserEmailAttachmentError } = await import('../app/lib/email/attachments');
    const actor = { userId: 'actor', attachmentWorkspaceId: 'source-workspace', mailboxWorkspaceId: 'mail-workspace' };
    const files = [{ source: 'workspace', path: 'memo.txt' }, { source: 'upload', uploadId: 'own' }, { source: 'upload', uploadId: 'shared' }];
    const snapshots = await snapshotBrowserEmailAttachments(files, actor);
    assert.equal(snapshots.length, 3); assert.ok(snapshots.every(file => file.source === 'upload' && file.uploadId?.startsWith('snapshot-')));
    assert.ok(saved.every(file => file.ownerUserId === 'actor' && file.workspaceId === 'mail-workspace'));
    assert.ok(calls.indexOf('authorize:source-workspace') < calls.indexOf('read-workspace'));
    const before = saved.length; calls.length = 0;
    await assert.rejects(snapshotBrowserEmailAttachments([{ source: 'upload', uploadId: 'someone-elses-private' }], actor), BrowserEmailAttachmentError);
    assert.ok(!calls.includes('read-upload')); assert.equal(saved.length, before);
    denyWorkspace = true; calls.length = 0;
    await assert.rejects(snapshotBrowserEmailAttachments([files[0]], actor), BrowserEmailAttachmentError);
    assert.ok(!calls.includes('stats')); assert.equal(saved.length, before);
    denyWorkspace = false;
    await assert.rejects(snapshotBrowserEmailAttachments([files[0]], { ...actor, attachmentWorkspaceId: undefined }), BrowserEmailAttachmentError);
    await assert.rejects(snapshotBrowserEmailAttachments([{ source: 'upload', uploadId: 'own', disposition: 'inline', contentId: 'image' }], actor), (error: unknown) => error instanceof BrowserEmailAttachmentError && error.status === 400);
    assert.equal(saved.length, before, 'Validation failures create no snapshot or draft material');
    console.log('Browser attachment snapshots passed: actor scope, upload grants, denied access before reads, stable upload copies, inline 400.');
  } finally { internal._load = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
