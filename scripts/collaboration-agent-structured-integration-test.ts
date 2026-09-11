import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { closeDatabaseConnections } from '../app/lib/db';
import { createCollaborationSessionGrant, parseCollaborationSessionRequest } from '../app/lib/collaboration/session-service';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { loadCollaborationState, persistCollaborationYDoc } from '../app/lib/collaboration/persistence';
import { installCollaborationDirectConnection } from '../app/lib/collaboration/direct-connection';
import { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import { readCurrentCollaborationTextSnapshot, prepareCollaborationBlockEdit } from '../app/lib/collaboration/agent-file-edits';
import { applyPersistedAgentTextOperation, getAgentOperation, revertAgentOperation, acceptAgentOperation } from '../app/lib/collaboration/agent-operations';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { richMarkdownFromYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { piTools } from '../app/lib/pi/core-tools';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentFileToolSuccess } from '../app/lib/pi/agent-file-tool-results';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_editor_test_\w+$/u,
    'Run only in an isolated disposable test database.');
  const rootPath = await fs.mkdtemp(path.join(process.env.DATA!, 'agent-structured-'));
  const workspace: WorkspaceContext = {
    workspaceId: randomUUID(), workspaceType: 'organization', organizationId: null, rootPath, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true },
  };
  const userId = randomUUID();
  const execution: AgentExecutionContext = {
    userId, agentId: 'canvas-agent', sessionId: randomUUID(), workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType, workspaceName: 'Structured test', organizationId: null,
    customerId: null, projectId: null, workspaceRoot: rootPath, workspaceRootRelativePath: null,
    canWrite: true, canDelete: true, canShare: true, legacy: false,
  };
  const filePath = 'structured.md';
  const initialMarkdown = 'AAA\n\nSame\n\nSame\n\nOther';
  await fs.writeFile(path.join(rootPath, filePath), initialMarkdown);
  const request = parseCollaborationSessionRequest({ path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES });
  assert(request);
  const grant = await createCollaborationSessionGrant({ workspace, fileOptions: { workspace }, request });
  assert.equal(grant.representation, 'tiptap_blocks');
  const state = await loadCollaborationState(grant.documentId);
  assert(state);
  const document = { documentId: grant.documentId, lifecycleGeneration: grant.lifecycleGeneration, schemaVersion: state.schemaVersion };
  let live = new Y.Doc();
  Y.applyUpdate(live, state.yjsState);
  const schema = getSchema(richMarkdownSchemaExtensions());
  const blocks = () => readAgentBlockStructure(live);
  const tree = () => new CollaborationBlockTree(live, schema);
  const humanText = (id: string, text: string) => {
    const current = tree().read();
    let target: ReturnType<typeof schema.nodeFromJSON> | undefined;
    current.descendants((node) => { if (node.attrs.id === id) target = node; });
    assert(target);
    tree().updateInlineContent(id, target.type.create(target.attrs, schema.text(text), target.marks), 'human');
  };
  let beforeApply: (() => void) | null = null;
  let readGate: { promise: Promise<void>; release: () => void; count: number } | null = null;
  let applyCount = 0;
  const uninstallRead = installCollaborationDocumentReader(async (id, workspaceId, read) => {
    assert.equal(id, document.documentId); assert.equal(workspaceId, workspace.workspaceId);
    const gate = readGate;
    if (gate) {
      gate.count += 1;
      if (gate.count === 2) { readGate = null; gate.release(); }
      await gate.promise;
    }
    return read(live);
  });
  const uninstallDirect = installCollaborationDirectConnection(async (input, apply, onApplied) => {
    const current = await loadCollaborationState(input.documentId);
    assert(current);
    assert.equal(input.documentLifecycleGeneration, current.lifecycleGeneration);
    assert.equal(input.documentSchemaVersion, current.schemaVersion);
    assert.equal(input.documentPath, current.path);
    assert.equal(input.documentRepresentation, 'tiptap_blocks');
    const before = beforeApply; beforeApply = null; before?.();
    applyCount += 1;
    const result = apply(live);
    await onApplied?.(result);
    await persistCollaborationYDoc(input.documentId, current.lifecycleGeneration, live);
    return result; // Deliberately never exports Markdown.
  });
  const run = async (name: 'read' | 'edit_file', params: Record<string, unknown>, key = randomUUID()) => {
    const tool = piTools.find((entry) => entry.name === name)!;
    const result = await runWithAgentExecutionContext(execution, () => tool.execute(key, params));
    return result as typeof result & { isError?: boolean };
  };
  const success = (response: Awaited<ReturnType<typeof run>>) => {
    assert(!response.isError, JSON.stringify(response));
    const details = response.details as AgentFileToolSuccess;
    assert.equal(details.collaboration?.durability, 'persisted_yjs', JSON.stringify(details));
    assert.equal(details.collaboration?.reviewRequired, false);
    return details;
  };
  try {
    const read = await run('read', { path: filePath, includeStructure: true });
    assert(!read.isError, JSON.stringify(read));
    const readText = read.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
    assert.match(readText, /documentId/u);
    assert.match(readText, /placementHash/u);
    const snapshot = await readCurrentCollaborationTextSnapshot({ documentId: document.documentId, workspace,
      includeStructure: true, structureLimit: 2 });
    assert.equal(snapshot.structure?.blocks.length, 2);
    assert.equal(snapshot.structure?.nextOffset, 2);
    const [first, sameA, sameB, other] = blocks();

    // A move prepared before a new human character preserves that character.
    const moveKey = randomUUID();
    const moveRequest = { path: filePath, document, operations: [{ kind: 'move_block', blockId: first.id,
      placementHash: first.placementHash, parentId: null, beforeId: null }] };
    beforeApply = () => humanText(first.id, 'AAA human');
    const moved = success(await run('edit_file', moveRequest, moveKey));
    assert.equal(blocks().at(-1)?.id, first.id);
    assert.equal(blocks().at(-1)?.text, 'AAA human');
    assert.equal(await fs.readFile(path.join(rootPath, filePath), 'utf8'), initialMarkdown);
    const movedBinary = Y.encodeStateAsUpdate(live);
    const retried = success(await run('edit_file', moveRequest, moveKey));
    assert.equal(retried.collaboration?.operationId, moved.collaboration?.operationId);
    assert.deepEqual(Y.encodeStateAsUpdate(live), movedBinary);
    assert((await run('edit_file', { ...moveRequest, operations: [{ ...moveRequest.operations[0], beforeId: sameA.id }] }, moveKey)).isError);

    // A persistent receipt works after the original room object is gone.
    const saved = await loadCollaborationState(document.documentId); assert(saved);
    const reopened = new Y.Doc(); Y.applyUpdate(reopened, saved.yjsState); live.destroy(); live = reopened;
    humanText(other.id, 'Other human');
    const moveRevert = await revertAgentOperation({ operationId: moved.collaboration!.operationId, workspace, userId, idempotencyKey: randomUUID() });
    assert.equal(moveRevert.operationStatus, 'reverted', JSON.stringify(moveRevert));
    assert.equal(moveRevert.durability, 'persisted_yjs');
    assert.deepEqual(blocks().map((block) => block.id), [first.id, sameA.id, sameB.id, other.id]);
    assert.equal(blocks()[0].text, 'AAA human'); assert.equal(blocks().at(-1)?.text, 'Other human');

    // Identical words elsewhere cannot borrow this block's explicit identity.
    success(await run('edit_file', { path: filePath, document, blockId: sameB.id, oldText: 'Same', newText: 'Second' }));
    assert.equal(blocks().find((block) => block.id === sameA.id)?.text, 'Same');
    assert.equal(blocks().find((block) => block.id === sameB.id)?.text, 'Second');
    const deleted = success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'delete_block',
      blockId: sameB.id, subtreeHash: blocks().find((block) => block.id === sameB.id)!.subtreeHash }] }));
    assert(!blocks().some((block) => block.id === sameB.id));
    humanText(other.id, 'Other after delete');
    const deleteRevert = await revertAgentOperation({ operationId: deleted.collaboration!.operationId, workspace, userId, idempotencyKey: randomUUID() });
    assert.equal(deleteRevert.operationStatus, 'reverted', JSON.stringify(deleteRevert));
    assert.equal(blocks().find((block) => block.id === sameB.id)?.text, 'Second');
    assert.equal(blocks().at(-1)?.text, 'Other after delete');

    // All requests in one logical group fail together when a target changed.
    const beforeIds = blocks().map((block) => block.id);
    beforeApply = () => humanText(sameA.id, 'Same human');
    const stale = await run('edit_file', { path: filePath, document, operations: [
      { kind: 'insert_blocks', parentId: null, beforeId: null, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'must not appear' }] }] },
      { kind: 'delete_block', blockId: sameA.id, subtreeHash: blocks().find((block) => block.id === sameA.id)!.subtreeHash },
    ] });
    assert.equal((stale.details as AgentFileToolSuccess).outcome, 'review_required', JSON.stringify(stale));
    assert.deepEqual(blocks().map((block) => block.id), beforeIds);
    assert.equal(blocks().find((block) => block.id === sameA.id)?.text, 'Same human');
    assert(!richMarkdownFromYDoc(live).includes('must not appear'));

    const inserted = success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'insert_blocks', parentId: null,
      beforeId: sameA.id, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'New block' }] }] }] }));
    const newBlock = blocks().find((block) => block.text === 'New block'); assert(newBlock);
    assert.equal(newBlock.beforeId, sameA.id);
    humanText(newBlock.id, 'New block edited by human');
    const unsafeRevert = await revertAgentOperation({ operationId: inserted.collaboration!.operationId, workspace, userId, idempotencyKey: randomUUID() });
    assert.equal(unsafeRevert.operationStatus, 'needs_review');
    assert.equal(blocks().find((block) => block.id === newBlock.id)?.text, 'New block edited by human');

    success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'insert_blocks', parentId: null,
      beforeId: null, blocks: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] }] }] }));
    const heading = blocks().find((block) => block.type === 'heading')!;
    beforeApply = () => humanText(heading.id, 'Heading human');
    const formatted = success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'format_block',
      blockId: heading.id, beforeAttrs: { level: 2 }, afterAttrs: { level: 3 } }] }));
    assert.equal(blocks().find((block) => block.id === heading.id)?.attrs.level, 3);
    assert.equal(blocks().find((block) => block.id === heading.id)?.text, 'Heading human');
    assert.equal((await revertAgentOperation({ operationId: formatted.collaboration!.operationId, workspace, userId,
      idempotencyKey: randomUUID() })).operationStatus, 'reverted');
    assert.equal(blocks().find((block) => block.id === heading.id)?.attrs.level, 2);
    assert.equal(blocks().find((block) => block.id === heading.id)?.text, 'Heading human');

    const cell = (type: string, text: string) => ({ type, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'insert_blocks', parentId: null,
      beforeId: null, blocks: [{ type: 'table', content: [
        { type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B')] },
        { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] },
      ] }] }] }));
    const table = blocks().find((block) => block.type === 'table')!;
    const bodyCell = blocks().find((block) => block.type === 'tableCell')!;
    const tableEdit = success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'table_operation',
      cellId: bodyCell.id, subtreeHash: table.subtreeHash, action: 'addRowAfter' }] }));
    assert.equal(blocks().filter((block) => block.type === 'tableRow').length, 3);
    humanText(other.id, 'Other after table');
    assert.equal((await revertAgentOperation({ operationId: tableEdit.collaboration!.operationId, workspace, userId,
      idempotencyKey: randomUUID() })).operationStatus, 'reverted');
    assert.equal(blocks().filter((block) => block.type === 'tableRow').length, 2);
    assert.equal(blocks().find((block) => block.id === other.id)?.text, 'Other after table');

    // Force both first deliveries to prepare independently from the same state.
    // Their generated IDs/deltas differ, but their server request fingerprint is identical.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    readGate = { promise: gate, release, count: 0 };
    const concurrentKey = randomUUID();
    const concurrentRequest = { path: filePath, document, operations: [{ kind: 'insert_blocks', parentId: null,
      beforeId: null, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Exactly once' }] }] }] };
    const countBeforeConcurrent = applyCount;
    const concurrent = await Promise.all([run('edit_file', concurrentRequest, concurrentKey), run('edit_file', concurrentRequest, concurrentKey)]);
    const concurrentResults = concurrent.map(success);
    assert.equal(concurrentResults[0].collaboration?.operationId, concurrentResults[1].collaboration?.operationId);
    assert.equal(concurrentResults[0].beforeSha256, concurrentResults[1].beforeSha256);
    assert.equal(concurrentResults[0].collaboration?.proposedSha256, concurrentResults[1].collaboration?.proposedSha256);
    assert.equal(applyCount, countBeforeConcurrent + 1);
    assert.equal(blocks().filter((block) => block.text === 'Exactly once').length, 1);

    const prepared = await prepareCollaborationBlockEdit({ document, workspace, path: filePath, groupId: 'review-move',
      operations: [{ kind: 'move_block', blockId: first.id, placementHash: blocks()[0].placementHash, parentId: null, beforeId: null }] });
    const proposal = await applyPersistedAgentTextOperation({ documentId: document.documentId, workspace, initiatedByUserId: userId,
      actorId: 'canvas-agent', actorDisplayName: 'Agent', runGeneration: 1, idempotencyKey: randomUUID(),
      requestedMode: 'review', targets: prepared.targets });
    const view = await getAgentOperation({ operationId: proposal.operationId, workspace, userId });
    assert(view?.reviewTargets?.[0].currentTargetHash, JSON.stringify(view));
    const approved = await acceptAgentOperation({ operationId: proposal.operationId, workspace, userId, idempotencyKey: randomUUID() });
    assert.equal(approved.durability, 'persisted_yjs', JSON.stringify(approved));

    success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'insert_blocks', parentId: null,
      beforeId: null, blocks: [{ type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
      ] }] }] }] }));
    const list = blocks().find((block) => block.type === 'bulletList')!;
    const listItem = blocks().find((block) => block.parentId === list.id)!;
    const listParagraph = blocks().find((block) => block.parentId === listItem.id)!;
    humanText(listParagraph.id, 'A\t\nB');
    assert.equal(validateRichMarkdownYDoc(live).code, 'roundtrip_unstable');
    success(await run('edit_file', { path: filePath, document, operations: [{ kind: 'move_block', blockId: list.id,
      placementHash: blocks().find((block) => block.id === list.id)!.placementHash, parentId: null, beforeId: blocks()[0].id }] }));
    assert.equal(blocks()[0].id, list.id);
    assert.equal(validateRichMarkdownYDoc(live).code, 'roundtrip_unstable', 'the export check remains active');
    assert.equal((await loadCollaborationState(document.documentId))?.degraded, false);
    assert.equal(await fs.readFile(path.join(rootPath, filePath), 'utf8'), initialMarkdown);

    const unchanged = Y.encodeStateAsUpdate(live);
    assert((await run('edit_file', { path: filePath, document: { ...document, lifecycleGeneration: document.lifecycleGeneration + 1 },
      operations: [{ kind: 'delete_block', blockId: first.id, subtreeHash: blocks().find((block) => block.id === first.id)!.subtreeHash }] })).isError);
    assert((await run('edit_file', { path: filePath, document, operations: [{ kind: 'reverse', update: 'foreign' }] })).isError);
    assert.deepEqual(Y.encodeStateAsUpdate(live), unchanged);
    console.log('collaboration-agent-structured-integration-test: ok');
  } finally {
    uninstallDirect(); uninstallRead(); live.destroy(); await fs.rm(rootPath, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDatabaseConnections());
