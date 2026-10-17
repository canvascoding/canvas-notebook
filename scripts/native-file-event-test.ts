import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlConnection } from '../app/lib/db';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import { withNativeWorkspaceFilesRead } from '../app/lib/collaboration/workspace-native-file-read';
import { classifyWorkspaceFilesystemEvent, type NativeFileEventDependencies } from '../app/lib/filesystem/native-file-event';
import type { FileEvent } from '../app/lib/filesystem/file-watcher';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = {
  workspaceId: 'native-event-workspace', organizationId: null, workspaceType: 'personal',
  rootPath: '/no-native-event-projection-reads', legacy: false, status: 'active',
  permissions: { canRead: true, canWrite: false, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false },
};
function event(type: FileEvent['type'] = 'add', relativePath = 'folder/note.md'): FileEvent {
  return { type, workspaceId: workspace.workspaceId, path: `${workspace.rootPath}/${relativePath}`,
    relativePath, dir: 'folder', timestamp: 100, fileVersion: 'private-physical-inode-version' };
}
function row(authority: WorkspaceDocumentCatalogueEntry['authority'] = 'initialized', filePath = 'folder/note.md'): WorkspaceDocumentCatalogueEntry {
  const initialized = authority === 'initialized';
  return { id: `document:${filePath}`, lineage_id: `lineage:${filePath}`, workspace_id: workspace.workspaceId,
    organization_id: null, path: filePath, status: 'active', state_version: authority === 'pristine' ? 0 : 4,
    yjs_state_lifecycle: authority === 'pristine' ? 'never_initialized' : 'initialized',
    has_persisted_state: initialized, has_state_history: authority !== 'pristine', lifecycle_generation: initialized ? 3 : null,
    authority, state_status: initialized ? 'active' : null, state_path: initialized ? filePath : null,
    state_workspace_id: initialized ? workspace.workspaceId : null, state_organization_id: null };
}

/** Uses the genuine namespace reader and catalogue validator. The SQL witness
 * has no state/content read or write implementation; this is not a PG run. */
function fixture(documents: WorkspaceDocumentCatalogueEntry[] = []) {
  const commands: string[] = [];
  const controls = { active: false, fenced: false, checkouts: 0, closes: 0, reads: 0, stateReads: 0,
    drift: false, fail: '' as '' | 'lock' | 'initial' | 'final' | 'commit' | 'close' };
  const connection = {
    run: async (sql: string) => {
      commands.push(sql); assert(!/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u.test(sql), 'classification cannot mutate SQL');
      if (sql === 'BEGIN READ ONLY') { assert.equal(controls.active, false); controls.active = true; return; }
      assert(controls.active, 'all namespace reads remain in the real helper transaction');
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (sql === 'COMMIT' && controls.fail === 'commit') throw new Error('witness commit failure');
        controls.active = false; controls.fenced = false;
      }
    },
    get: async (sql: string) => {
      commands.push(sql); assert(controls.active);
      if (sql.includes('pg_advisory_xact_lock_shared')) {
        if (controls.fail === 'lock') throw new Error('witness fence failure');
        controls.fenced = true; return { locked: true };
      }
      assert(controls.fenced);
      if (sql.includes('LEFT JOIN collaboration_documents') || sql.includes('SELECT d.path FROM collaboration_documents')) return undefined;
      controls.stateReads++; throw new Error('Native state/content reads are forbidden in an event classification.');
    },
    all: async (sql: string, args?: unknown[]) => {
      commands.push(sql); assert(controls.active && controls.fenced);
      assert(sql.includes('FROM collaboration_documents d LEFT JOIN collaboration_yjs_states'));
      assert.equal(args?.[0], workspace.workspaceId); assert.equal(args?.[2], 2, 'maxEntries=1 retains overflow detection');
      const paths = args?.[1] as string[]; assert.equal(paths.length, 1);
      controls.reads++;
      if (controls.fail === 'initial' && controls.reads === 1 || controls.fail === 'final' && controls.reads === 2) {
        throw new Error('witness catalogue failure');
      }
      return documents.filter(document => document.path === paths[0] || document.path.startsWith(`${paths[0]}/`))
        .map(document => ({ ...document, state_version: controls.drift && controls.reads > 1 ? document.state_version + 1 : document.state_version }));
    },
    close: async () => { assert.equal(controls.active, false); controls.closes++; if (controls.fail === 'close') throw new Error('witness close failure'); },
  } as unknown as SqlConnection;
  const withNamespaceRead: typeof withNativeWorkspaceFilesRead = (input, consume) => {
    assert.equal(input.maxEntries, 1); assert.equal(input.paths.length, 1);
    return withNativeWorkspaceFilesRead(input, async scope => {
      assert(controls.active && controls.fenced, 'classification callback runs inside the genuine helper fence');
      const result = await consume(scope);
      assert(controls.active && controls.fenced, 'classification cannot end or release the shared read fence');
      return result;
    }, {
      openConnection: async () => { controls.checkouts++; return connection; },
      readCatalogue: readWorkspaceDocumentCatalogue,
      loadState: async () => { controls.stateReads++; throw new Error('Native content must not be loaded.'); },
    });
  };
  return { controls, commands, dependencies: { withNamespaceRead } satisfies NativeFileEventDependencies };
}

for (const authority of ['initialized', 'missing-state'] as const) for (const type of ['add', 'change', 'unlink'] as const) {
  test(`${authority}: physical ${type} is a native projection change with no physical version`, async () => {
    const f = fixture([row(authority)]), original = event(type), before = structuredClone(original);
    const classified = await classifyWorkspaceFilesystemEvent({ workspace, event: original }, f.dependencies);
    assert.deepEqual(classified, { type: 'change', workspaceId: workspace.workspaceId,
      path: original.path, relativePath: original.relativePath, dir: original.dir, timestamp: original.timestamp });
    assert.equal(Object.hasOwn(classified, 'fileVersion'), false); assert.deepEqual(original, before);
    assert.equal(f.controls.reads, 2); assert.equal(f.controls.checkouts, 1); assert.equal(f.controls.closes, 1);
    assert.equal(f.controls.stateReads, 0); assert.equal(f.commands[0], 'BEGIN READ ONLY'); assert.equal(f.commands.at(-1), 'COMMIT');
    assert.equal(f.commands.filter(command => command.includes('pg_advisory_xact_lock_shared')).length, 1);
  });
}

test('classification follows genuine catalogue authority instead of the file extension', async () => {
  for (const filePath of ['renamed.bin', 'renamed.pdf', 'renamed.docx']) {
    const f = fixture([row('initialized', filePath)]);
    const classified = await classifyWorkspaceFilesystemEvent({ workspace, event: event('add', filePath) }, f.dependencies);
    assert.equal(classified.type, 'change'); assert.equal(Object.hasOwn(classified, 'fileVersion'), false);
  }
});

test('ordinary assets, unregistered Markdown and explicitly pristine registrations retain their real filesystem events', async () => {
  for (const filePath of ['folder/asset.pdf', 'folder/image.png', 'folder/note.md']) for (const type of ['add', 'change', 'unlink'] as const) {
    for (const documents of [[], [row('pristine', filePath)]]) {
      const f = fixture(documents), original = event(type, filePath);
      assert.deepEqual(await classifyWorkspaceFilesystemEvent({ workspace, event: original }, f.dependencies), original);
      assert.equal(f.controls.reads, 2); assert.equal(f.controls.stateReads, 0);
    }
  }
});

test('directory events and explicit managed renames remain unchanged without a file authority lookup', async () => {
  const f = fixture([row()]);
  for (const type of ['addDir', 'unlinkDir', 'rename'] as const) {
    const original = event(type);
    assert.deepEqual(await classifyWorkspaceFilesystemEvent({ workspace, event: original }, f.dependencies), original);
  }
  assert.equal(f.controls.checkouts, 0); assert.deepEqual(f.commands, []);
});

test('namespace/fence/COMMIT/close failures propagate instead of falling back to a physical birth or deletion', async () => {
  for (const failure of ['lock', 'initial', 'final', 'commit', 'close'] as const) {
    const f = fixture([row()]); f.controls.fail = failure;
    await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace, event: event() }, f.dependencies), /witness/u);
    assert.equal(f.controls.closes, 1); assert.equal(f.controls.active, false); assert.equal(f.controls.stateReads, 0);
    if (failure !== 'close') assert(f.commands.includes('ROLLBACK'), `${failure} cannot commit an uncertain classification`);
  }
});

test('the genuine helper final catalogue comparison rejects a changed identity before returning the event', async () => {
  const f = fixture([row()]); f.controls.drift = true;
  await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace, event: event() }, f.dependencies), { code: 'ARCHIVE_SOURCE_CHANGED' });
  assert.equal(f.controls.reads, 2); assert(f.commands.includes('ROLLBACK')); assert.equal(f.commands.includes('COMMIT'), false);
});

test('foreign catalogue identity is rejected by the original catalogue validator', async () => {
  for (const changes of [{ workspace_id: 'foreign' }, { organization_id: 'foreign' }, { state_path: 'other.md' }]) {
    const f = fixture([{ ...row(), ...changes }]);
    await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace, event: event() }, f.dependencies), { code: 'identity-conflict' });
    assert(f.commands.includes('ROLLBACK')); assert.equal(f.controls.closes, 1);
  }
});

test('a descendant or overflowing catalogue is not mistaken for an exact nonnative path', async () => {
  const f = fixture([row('initialized', 'folder/note.md/child.md')]);
  await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace, event: event() }, f.dependencies), { code: 'NATIVE_FILE_EVENT_SOURCE_CHANGED' });
  const overflow = fixture([row(), row('initialized', 'folder/note.md/child.md')]);
  await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace, event: event() }, overflow.dependencies), { code: 'NATIVE_CATALOGUE_TOO_LARGE' });
});

test('event workspace, canonical path and current read permission are validated before any namespace lookup', async () => {
  const f = fixture([row()]);
  for (const changed of [{ workspaceId: 'foreign' }, { relativePath: '../outside.md' }, { relativePath: '/outside.md' },
    { relativePath: 'folder\\note.md' }, { relativePath: '.' }]) {
    await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace, event: { ...event(), ...changed } }, f.dependencies), { code: 'NATIVE_FILE_EVENT_SOURCE_CHANGED' });
  }
  await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace: { ...workspace, permissions: { ...workspace.permissions, canRead: false } },
    event: event() }, f.dependencies), { status: 403 });
  await assert.rejects(classifyWorkspaceFilesystemEvent({ workspace: { ...workspace, status: 'archived' }, event: event() }, f.dependencies), { status: 403 });
  assert.equal(f.controls.checkouts, 0);
});
