import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';

import { openDb } from '../app/lib/db';
import { createCollaborationSessionGrant, CollaborationSessionError, parseCollaborationSessionRequest } from '../app/lib/collaboration/session-service';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { changeCollaborationRepresentation, CollaborationRepresentationMigrationError, loadCollaborationState,
  persistCollaborationYDoc, CollaborationStateStaleError } from '../app/lib/collaboration/persistence';
import { materializeCollaborationCheckpoint } from '../app/lib/collaboration/checkpoint';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { richMarkdownFromYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';
import { installCollaborationRoomInspector } from '../app/lib/collaboration/runtime-state';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichAgentTextTargets, applyPersistedAgentTextOperation, revertAgentOperation, getAgentOperation } from '../app/lib/collaboration/agent-operations';
import { installCollaborationDirectConnection } from '../app/lib/collaboration/direct-connection';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_editor_test_\w+$/u,
    'This suite requires its own disposable database on the managed local PostgreSQL server.');
  const rootPath = await fs.mkdtemp(path.join(process.env.DATA!, 'block-format-'));
  const workspace: WorkspaceContext = {
    workspaceId: randomUUID(), workspaceType: 'organization', organizationId: null, rootPath, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true },
  };
  const filePath = 'shared.md';
  const markdown = '# Shared\n\nAAA\n\nBBB\n';
  await fs.writeFile(path.join(rootPath, filePath), markdown);
  const grant = (extra: Record<string, unknown> = {}) => {
    const request = parseCollaborationSessionRequest({ path: filePath, representation: 'auto', ...extra });
    assert(request);
    return createCollaborationSessionGrant({ workspace, fileOptions: { workspace }, request });
  };
  const legacy = await grant();
  assert.equal(legacy.representation, 'tiptap_xml');
  const initial = await loadCollaborationState(legacy.documentId);
  assert(initial);
  const original = new Y.Doc();
  Y.applyUpdate(original, initial.yjsState);
  const json = readRichDocumentJson(original);
  const migrate = () => changeCollaborationRepresentation({ documentId: legacy.documentId,
    expectedLifecycleGeneration: 1, representation: 'tiptap_blocks', schemaVersion: 1 });

  let active = 1;
  const uninstall = installCollaborationRoomInspector(() => active);
  try {
    await assert.rejects(migrate, (error: unknown) => error instanceof CollaborationRepresentationMigrationError && error.code === 'room_active');
    const busy = await grant({ ...COLLABORATION_CLIENT_CAPABILITIES, allowRichMigration: true, expectedLifecycleGeneration: 1 });
    assert.equal(busy.representation, 'tiptap_xml');
    assert.equal(busy.lifecycleGeneration, 1);
    active = 0;

    // A persisted update without a confirmed file projection must prevent migration.
    original.getText('frontmatter').insert(0, '---\ntitle: Updated\n---\n\n');
    const pending = await persistCollaborationYDoc(legacy.documentId, 1, original);
    await assert.rejects(migrate, (error: unknown) => error instanceof CollaborationRepresentationMigrationError && error.code === 'checkpoint_stale');
    await materializeCollaborationCheckpoint({ state: pending, workspace, actorType: 'system' });
    const source = await loadCollaborationState(legacy.documentId);
    assert(source);
    assert.equal(source.checkpointSequence, source.documentSequence);

    const upgraded = await grant({ ...COLLABORATION_CLIENT_CAPABILITIES, allowRichMigration: true, expectedLifecycleGeneration: 1 });
    assert.equal(upgraded.representation, 'tiptap_blocks');
    assert.equal(upgraded.lifecycleGeneration, 2);
    const state = await loadCollaborationState(legacy.documentId);
    assert(state);
    assert.equal(state.checkpointSequence, state.documentSequence);
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, state.yjsState);
      assert.deepEqual(readRichDocumentJson(restored), json);
      assert.equal(restored.share.has('body'), false);
      assert.equal(richMarkdownFromYDoc(restored), richMarkdownFromYDoc(original));
      assert.equal(await fs.readFile(path.join(rootPath, filePath), 'utf8'), richMarkdownFromYDoc(restored));
    } finally { restored.destroy(); }
    const database = await openDb();
    try {
      const backup = await database.get('SELECT yjs_state, lifecycle_generation, representation FROM collaboration_yjs_state_backups WHERE document_id = ?', [legacy.documentId]) as {
        yjs_state: Buffer; lifecycle_generation: number | string; representation: string;
      };
      assert(backup);
      assert.equal(backup.representation, 'tiptap_xml');
      assert.equal(Number(backup.lifecycle_generation), 1);
      assert.deepEqual(new Uint8Array(backup.yjs_state), new Uint8Array(source.yjsState));
    } finally { await database.close(); }

    await assert.rejects(() => grant(), (error: unknown) => error instanceof CollaborationSessionError && error.code === 'representation_mismatch');
    await assert.rejects(() => grant({ ...COLLABORATION_CLIENT_CAPABILITIES, blockTreeFormatVersion: 99 }),
      (error: unknown) => error instanceof CollaborationSessionError && error.code === 'representation_mismatch');
    const reopened = await grant(COLLABORATION_CLIENT_CAPABILITIES);
    assert.equal(reopened.representation, 'tiptap_blocks');
    assert.equal(reopened.lifecycleGeneration, 2);
    await assert.rejects(() => persistCollaborationYDoc(legacy.documentId, 1, original), CollaborationStateStaleError);
    await assert.rejects(migrate, (error: unknown) => error instanceof CollaborationRepresentationMigrationError && error.code === 'lifecycle_stale');

    const moved = new Y.Doc();
    Y.applyUpdate(moved, state.yjsState);
    const targets = createRichAgentTextTargets({ doc: moved, search: 'BBB', replacement: 'NEW' });
    const tree = new CollaborationBlockTree(moved, getSchema(richMarkdownSchemaExtensions()));
    tree.move({ blockId: tree.read().lastChild!.attrs.id, parentId: null,
      beforeId: tree.read().firstChild!.attrs.id, operationId: 'move-before-agent-apply' }, 'user');
    const movedState = await persistCollaborationYDoc(legacy.documentId, 2, moved);
    await materializeCollaborationCheckpoint({ state: movedState, workspace, actorType: 'system' });
    moved.destroy();
    const uninstallDirect = installCollaborationDirectConnection(async (input, apply, onApplied) => {
      const current = await loadCollaborationState(input.documentId);
      assert(current);
      assert.equal(input.documentRepresentation, current.representation);
      assert.equal(input.documentLifecycleGeneration, current.lifecycleGeneration);
      const live = new Y.Doc();
      try {
        Y.applyUpdate(live, current.yjsState);
        const result = apply(live);
        await onApplied?.(result);
        const persisted = await persistCollaborationYDoc(input.documentId, current.lifecycleGeneration, live);
        await materializeCollaborationCheckpoint({ state: persisted, workspace, actorType: 'agent' });
        return result;
      } finally { live.destroy(); }
    });
    try {
      const userId = 'block-test-user';
      const applied = await applyPersistedAgentTextOperation({ documentId: legacy.documentId, workspace,
        initiatedByUserId: userId, actorId: 'block-agent', actorDisplayName: 'Block Agent', targets,
        runGeneration: 1, idempotencyKey: randomUUID(), explicitUserRequest: true });
      assert.equal(applied.operationStatus, 'checkpointed_file', JSON.stringify(applied));
      assert.match(await fs.readFile(path.join(rootPath, filePath), 'utf8'), /NEW\n\n# Shared\n\nAAA\n$/u);
      const operation = await getAgentOperation({ operationId: applied.operationId, workspace, userId });
      assert.equal(operation?.targetAnchors[0].blockId, targets[0].blockId);
      const reverted = await revertAgentOperation({ operationId: applied.operationId, workspace, userId, idempotencyKey: randomUUID() });
      assert.equal(reverted.operationStatus, 'reverted', JSON.stringify(reverted));
      assert.equal(reverted.durability, 'checkpointed_file');
      assert.match(await fs.readFile(path.join(rootPath, filePath), 'utf8'), /BBB\n\n# Shared\n\nAAA\n$/u);
    } finally { uninstallDirect(); }

    const newPath = 'new.md';
    await fs.writeFile(path.join(rootPath, newPath), markdown);
    const initialized = await grant({ path: newPath, ...COLLABORATION_CLIENT_CAPABILITIES });
    assert.equal(initialized.representation, 'tiptap_blocks');
    assert.equal(initialized.lifecycleGeneration, 1);
    console.log('Block format integration: sessions, migration, backup, stale generations, moved agent targets, checkpoints and revert passed.');
  } finally {
    uninstall(); original.destroy();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

void main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
