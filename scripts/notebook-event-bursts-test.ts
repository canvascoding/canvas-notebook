import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileWatcherService, type FileEvent } from '../app/lib/filesystem/file-watcher';
import { getWorkspacePresenceSnapshot, upsertDocumentPresenceEntry } from '../app/lib/collaboration/presence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { FilePresenceEntry } from '../app/lib/collaboration/types';

async function main() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-event-bursts-'));
  const workspace: WorkspaceContext = { workspaceId: 'bursts', workspaceType: 'personal', rootPath, organizationId: null, ownerUserId: null, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: true } };
  const service = new FileWatcherService();
  const events: Array<{ event: FileEvent; receivedAt: number }> = [];
  try {
    await fs.writeFile(path.join(rootPath, 'active.txt'), 'base');
    service.subscribe({ id: 'client', workspace, workspaceId: workspace.workspaceId, send: (event) => events.push({ event, receivedAt: Date.now() }) });
    await service.subscribeDir('client', '.');
    const started = Date.now();
    for (let index = 0; index < 13; index += 1) {
      await fs.writeFile(path.join(rootPath, 'active.txt'), `edit ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const first = events.find(({ event }) => event.relativePath === 'active.txt');
    assert.ok(first, 'continuous writes must flush before the burst ends');
    assert.ok(first.receivedAt - started < 1150, 'the server bounds debounce latency during a sustained burst');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const entry: FilePresenceEntry = { workspaceId: workspace.workspaceId, path: 'active.txt', documentId: 'source-document', userId: 'agent', actorType: 'agent', sessionId: 'session', initiatedByUserId: null, displayName: 'Agent', color: '#000', colorLight: '#fff', activity: 'editing', updatedAt: Date.now() };
    upsertDocumentPresenceEntry(entry);
    upsertDocumentPresenceEntry({ ...entry, documentId: 'overwritten-document', path: 'renamed.txt' });
    await fs.writeFile(path.join(rootPath, 'renamed.txt'), 'overwritten');
    await service.withRename(workspace, { type: 'rename', operationId: 'rename', workspaceId: workspace.workspaceId, oldPath: 'active.txt', newPath: 'renamed.txt' }, () => fs.rename(path.join(rootPath, 'active.txt'), path.join(rootPath, 'renamed.txt')));
    upsertDocumentPresenceEntry({ ...entry, updatedAt: Date.now() + 1 });
    upsertDocumentPresenceEntry({ ...entry, documentId: 'overwritten-document', path: 'renamed.txt', updatedAt: Date.now() + 1 });
    const presence = getWorkspacePresenceSnapshot(workspace.workspaceId);
    assert.equal(presence.entries.length, 1);
    assert.equal(presence.entries[0].path, 'renamed.txt', 'late awareness retains the committed path');
    assert.equal(presence.entries[0].documentId, 'source-document');
    console.log('notebook-event-bursts-test: ok');
  } finally { service.stop(); await fs.rm(rootPath, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
