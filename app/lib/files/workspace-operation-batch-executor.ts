import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';
import { resolveExistingWorkspacePath, withWorkspaceCopyMutationLocks } from '@/app/lib/filesystem/workspace-files';
import { filesystemFileVersion } from '@/app/lib/filesystem/file-version';
import { trashWorkspacePaths, restoreWorkspaceTrashEntry, listWorkspaceTrashEntries } from '@/app/lib/filesystem/workspace-trash';
import { archiveFileCollaborationPaths, restoreFileCollaborationPath } from './collaboration-policy';
import { syncPublicSharesAfterDelete } from '@/app/lib/public-sharing/public-file-shares';
import { renameWorkspacePath } from './rename-service';
import { captureWorkspaceOperationBackup } from './workspace-operation-backup';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { preflightWorkspaceLinkWrites, applyWorkspaceLinkWriteGroup, probeWorkspaceLinkWriteGroup,
  type WorkspaceLinkWriteExecutorInput, type WorkspaceLinkWritePreflight } from '@/app/lib/markdown/workspace-link-write-executor';
import { groupWorkspaceLinkWrites, type WorkspaceLinkWriteGroup } from '@/app/lib/markdown/workspace-link-write-groups';
import { authoritativeCollaborationSnapshot, materializeCollaborationCheckpoint } from '@/app/lib/collaboration/checkpoint';
import { loadCollaborationState, serializeCanonicalText } from '@/app/lib/collaboration/persistence';
import { computeWorkspaceFileOperationPlanId } from '@/app/lib/markdown/workspace-file-operation-planner';
import { buildWorkspacePlannerSnapshot } from '@/app/lib/markdown/workspace-file-operation-preview';
import { buildWorkspaceLinkIndexFromDocuments } from '@/app/lib/markdown/workspace-link-index-core';
import { parseWorkspaceMarkdownHref } from '@/app/lib/markdown/workspace-local-link-parser';
import { buildWorkspaceOperationBatchPlan, computeWorkspaceOperationBatchPlanId } from './workspace-operation-batch-plan';
import type { WorkspaceOperationBatchExecutionResult, WorkspaceOperationBatchPlan, WorkspaceOperationBatchProgress,
  WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u;
const samePath = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);
type TreeEntry = { path: string; kind: 'file' | 'directory'; identity: string; sha256: string | null };
type Step = { key: string; state: 'intent' | 'applied'; receipt: Record<string, unknown> | null };
type Manifest = {
  version: 1; batchId: string; workspaceId: string; actorUserId: string; plan: WorkspaceOperationBatchPlan;
  status: 'preparing' | 'applying' | 'applied' | 'needs_recovery' | 'failed' | 'undoing' | 'undone';
  beforeTrees: Record<string, TreeEntry[]>; backupIds: string[]; linkPreflight: WorkspaceLinkWritePreflight | null;
  steps: Step[]; undoSteps: Step[]; undoPlan: WorkspaceOperationBatchPlan['linkPlan'] | null;
  undoPreflight: WorkspaceLinkWritePreflight | null; errorCode: string | null;
};
type ExecuteInput = { batchId: string; plan: WorkspaceOperationBatchPlan; scope: WorkspaceOperationBatchScope;
  actorUserId: string; actorDisplayName: string;
  onProgress?: (progress: WorkspaceOperationBatchProgress) => void | Promise<void> };
type UndoInput = Omit<ExecuteInput, 'plan'>;

type Dependencies = {
  storageRoot?: string;
  rebuild?: typeof buildWorkspaceOperationBatchPlan;
  rename?: typeof renameWorkspacePath;
  trash?: typeof trashWorkspacePaths;
  listTrash?: typeof listWorkspaceTrashEntries;
  restoreTrash?: typeof restoreWorkspaceTrashEntry;
  archive?: typeof archiveFileCollaborationPaths;
  restoreCollaboration?: typeof restoreFileCollaborationPath;
  sharesDeleted?: typeof syncPublicSharesAfterDelete;
  backup?: typeof captureWorkspaceOperationBackup;
  preflight?: typeof preflightWorkspaceLinkWrites;
  applyLink?: typeof applyWorkspaceLinkWriteGroup;
  probeLink?: typeof probeWorkspaceLinkWriteGroup;
  checkpointLink?: (input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup, documentId: string | null) => Promise<void>;
};

async function checkpointBatchLink(input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup, documentId: string | null): Promise<void> {
  if (!documentId) return;
  const state = await loadCollaborationState(documentId);
  if (!state || state.workspaceId !== group.workspaceId || state.path !== group.path
    || digest(serializeCanonicalText(authoritativeCollaborationSnapshot(state).canonicalContent, state)) !== group.afterSha256) {
    throw new Error('BATCH_CHECKPOINT_STATE_CHANGED');
  }
  const diskHash = digest(await fs.readFile(await resolveExistingWorkspacePath(group.path, input.destination.fileOptions)));
  if (diskHash !== group.beforeSha256 && diskHash !== group.afterSha256) throw new Error('BATCH_CHECKPOINT_FILE_CHANGED');
  // The queued projector cannot acquire the workspace lock while this batch owns it.
  // Reuse its transactional lifecycle/sequence fence in our reentrant lock instead.
  if (diskHash !== group.afterSha256 || state.checkpointSequence < state.documentSequence) {
    await materializeCollaborationCheckpoint({ state, workspace: input.destination.workspace,
      actorUserId: input.actorUserId, actorType: input.actorType ?? 'user', sourceSessionId: input.actorSessionId });
  }
}

async function treeAt(root: string): Promise<TreeEntry[]> {
  const tree: TreeEntry[] = [];
  const realRoot = await fs.realpath(root);
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('BATCH_UNSAFE_PATH');
    const realPath = await fs.realpath(absolute);
    if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) throw new Error('BATCH_UNSAFE_PATH');
    let sha256 = null;
    if (stat.isFile()) {
      const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        while (true) {
          const read = await handle.read(buffer, 0, buffer.length, offset);
          if (!read.bytesRead) break;
          hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
        }
        if (offset !== stat.size) throw new Error('BATCH_SOURCE_CHANGED');
        sha256 = hash.digest('hex');
      } finally { await handle.close(); }
    }
    const after = await fs.lstat(absolute);
    if (filesystemFileVersion(stat) !== filesystemFileVersion(after)) throw new Error('BATCH_SOURCE_CHANGED');
    tree.push({ path: relative, kind: stat.isDirectory() ? 'directory' : 'file', identity: `${stat.dev}:${stat.ino}`, sha256 });
    if (stat.isDirectory()) for (const name of (await fs.readdir(absolute)).sort()) {
      await visit(path.join(absolute, name), relative === '.' ? name : `${relative}/${name}`);
    }
  };
  await visit(root, '.');
  return tree;
}

async function privateDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.geteuid?.()) throw new Error('BATCH_UNSAFE_STORAGE');
}

/** Durable batch coordinator. Path receipts are required before a post-state can be resumed. */
export function createWorkspaceOperationBatchExecutor(dependencies: Dependencies = {}) {
  const storage = dependencies.storageRoot ?? path.join(resolveCanvasDataRoot(), 'workspace-operation-batches');
  const rebuild = dependencies.rebuild ?? buildWorkspaceOperationBatchPlan;
  const rename = dependencies.rename ?? renameWorkspacePath;
  const trash = dependencies.trash ?? trashWorkspacePaths;
  const listTrash = dependencies.listTrash ?? listWorkspaceTrashEntries;
  const restoreTrash = dependencies.restoreTrash ?? restoreWorkspaceTrashEntry;
  const archive = dependencies.archive ?? archiveFileCollaborationPaths;
  const restoreCollaboration = dependencies.restoreCollaboration ?? restoreFileCollaborationPath;
  const sharesDeleted = dependencies.sharesDeleted ?? syncPublicSharesAfterDelete;
  const backup = dependencies.backup ?? captureWorkspaceOperationBackup;
  const preflight = dependencies.preflight ?? preflightWorkspaceLinkWrites;
  const applyLink = dependencies.applyLink ?? applyWorkspaceLinkWriteGroup;
  const probeLink = dependencies.probeLink ?? probeWorkspaceLinkWriteGroup;
  const checkpointLink = dependencies.checkpointLink ?? checkpointBatchLink;
  const filename = (batchId: string) => {
    if (!idPattern.test(batchId)) throw new Error('BATCH_INVALID_ID');
    return path.join(storage, `${batchId}.json`);
  };
  const syncDirectory = async () => {
    const handle = await fs.open(storage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const save = async (manifest: Manifest): Promise<void> => {
    await privateDirectory(storage);
    const payload = JSON.stringify(manifest);
    if (Buffer.byteLength(payload) > 144 * 1024 * 1024) throw new Error('BATCH_STAGE_TOO_LARGE');
    const temporary = path.join(storage, `${manifest.batchId}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ payload, sha256: digest(payload) }));
      await handle.sync();
    } finally { await handle.close(); }
    try { await fs.rename(temporary, filename(manifest.batchId)); await syncDirectory(); }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  };
  const load = async (batchId: string): Promise<Manifest | null> => {
    filename(batchId);
    try {
      const directory = await fs.lstat(storage);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
        || directory.uid !== process.geteuid?.()) throw new Error('BATCH_UNSAFE_STORAGE');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(filename(batchId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.geteuid?.() || stat.size > 160 * 1024 * 1024) throw new Error('BATCH_UNSAFE_STORAGE');
      const stored = JSON.parse(await handle.readFile('utf8')) as { payload: string; sha256: string };
      if (digest(stored.payload) !== stored.sha256) throw new Error('BATCH_CORRUPT_MANIFEST');
      const manifest = JSON.parse(stored.payload) as Manifest;
      if (manifest.version !== 1 || manifest.batchId !== batchId || manifest.workspaceId !== manifest.plan.workspaceId
        || computeWorkspaceOperationBatchPlanId(manifest.plan) !== manifest.plan.planId
        || computeWorkspaceFileOperationPlanId(manifest.plan.linkPlan) !== manifest.plan.linkPlan.planId) throw new Error('BATCH_CORRUPT_MANIFEST');
      return manifest;
    } finally { await handle.close(); }
  };
  const assertAccess = (input: UndoInput | ExecuteInput) => {
    const workspace = input.scope.workspace;
    if (!workspace.permissions.canRead || !workspace.permissions.canWrite || !workspace.permissions.canDelete
      || workspace.status && workspace.status !== 'active'
      || input.scope.fileOptions.workspace && input.scope.fileOptions.workspace.workspaceId !== workspace.workspaceId) {
      throw Object.assign(new Error('BATCH_ACCESS_DENIED'), { status: 403 });
    }
  };
  const result = (manifest: Manifest): WorkspaceOperationBatchExecutionResult => ({
    status: manifest.status === 'applied' || manifest.status === 'undone' ? 'applied' : manifest.status === 'failed' ? 'failed' : 'needs_recovery',
    trashEntryIds: manifest.steps.flatMap((step) => typeof step.receipt?.trashEntryId === 'string' ? [step.receipt.trashEntryId] : []),
    completedActions: manifest.steps.filter((step) => step.state === 'applied').length,
    totalActions: manifest.plan.pathSteps.length + manifest.plan.previewContents.length, errorCode: manifest.errorCode,
    stepResults: manifest.steps.map((step) => {
      const index = Number(step.key.split(':')[1]);
      const pathStep = step.key.startsWith('path:') ? manifest.plan.pathSteps[index] : undefined;
      const group = !pathStep ? groupWorkspaceLinkWrites(manifest.plan.linkPlan)[index] : undefined;
      return { key: step.key, phase: pathStep ? 'path' as const : 'link' as const, state: step.state,
        path: pathStep?.sourcePath ?? group!.path,
        ...(pathStep ? { reviewId: pathStep.reviewId, destinationPath: pathStep.destinationPath,
          sourceIdentity: manifest.plan.expectedPathState.find((entry) => entry.path === pathStep.sourcePath)?.identity ?? undefined } : {}),
        ...(typeof step.receipt?.mutationId === 'string' ? { mutationId: step.receipt.mutationId } : {}),
        ...(typeof step.receipt?.trashEntryId === 'string' ? { trashEntryId: step.receipt.trashEntryId } : {}),
      };
    }),
  });
  const progress = async (input: UndoInput | ExecuteInput, manifest: Manifest, phase: WorkspaceOperationBatchProgress['phase']) => {
    const outcome = result(manifest);
    await input.onProgress?.({ completedActions: outcome.completedActions, totalActions: outcome.totalActions, phase });
    assertAccess(input);
  };
  const linkInput = (input: UndoInput | ExecuteInput, manifest: Manifest, undo = false): WorkspaceLinkWriteExecutorInput => ({
    plan: undo ? manifest.undoPlan! : manifest.plan.linkPlan,
    source: input.scope, destination: input.scope, actorUserId: input.actorUserId,
    actorId: input.actorUserId, actorDisplayName: input.actorDisplayName, actorType: 'user',
    operationId: `${manifest.batchId}${undo ? '-undo' : ''}`,
  });
  const recoveredUndoLinks = (input: UndoInput, manifest: Manifest) => {
    const restoredRoots = manifest.plan.pathSteps.filter((step, index) => step.kind !== 'delete'
      && manifest.undoSteps.some((receipt) => receipt.key === `path:${index}` && receipt.state === 'applied'));
    const location = (current: string) => {
      const restored = restoredRoots.find((step) => samePath(current, step.destinationPath!));
      return restored ? `${restored.sourcePath}${current.slice(restored.destinationPath!.length)}` : current;
    };
    const raw = { ...manifest.undoPlan!,
      previewContents: manifest.undoPlan!.previewContents.map((document) => ({ ...document, path: location(document.path) })),
      linkEdits: manifest.undoPlan!.linkEdits.map((edit) => ({ ...edit, sourcePathAfter: location(edit.sourcePathAfter) })),
      pathMappings: manifest.undoPlan!.pathMappings.map((mapping) => ({ ...mapping, destinationPath: location(mapping.destinationPath) })),
    };
    const plan = { ...raw, planId: computeWorkspaceFileOperationPlanId(raw) };
    const groups = groupWorkspaceLinkWrites(plan);
    const sources = groups.map((group) => manifest.undoPreflight!.sources.find((source) => source.sourcePathBefore === group.sourcePathBefore)!);
    return { input: { ...linkInput(input, manifest, true), plan }, groups,
      preflight: groups.length ? { planId: plan.planId, sources } : undefined };
  };
  const pathTree = async (scope: WorkspaceOperationBatchScope, relative: string): Promise<TreeEntry[] | null> => {
    try { return await treeAt(await resolveExistingWorkspacePath(relative, scope.fileOptions)); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; }
  };
  const pathProbe = async (input: UndoInput | ExecuteInput, manifest: Manifest, index: number): Promise<'before' | 'after' | 'unknown'> => {
    const step = manifest.plan.pathSteps[index];
    const receipt = manifest.steps.find((entry) => entry.key === `path:${index}`)?.receipt;
    const sourceTree = await pathTree(input.scope, step.sourcePath);
    if (!receipt) return JSON.stringify(sourceTree) === JSON.stringify(manifest.beforeTrees[step.sourcePath])
      && (step.kind === 'delete' || await pathTree(input.scope, step.destinationPath!) === null) ? 'before' : 'unknown';
    if (sourceTree) {
      if (sourceTree[0]?.identity === manifest.beforeTrees[step.sourcePath]?.[0]?.identity) return 'unknown';
      // A removed source may only reappear as an explicitly reviewed final destination
      // (or its parent directory). A delayed projection must not recreate a deleted file.
      if (sourceTree.some((entry) => {
        const finalPath = entry.path === '.' ? step.sourcePath : `${step.sourcePath}/${entry.path}`;
        return !manifest.plan.pathMappings.some((mapping) => entry.kind === 'directory'
          ? samePath(mapping.destinationPath, finalPath) || mapping.destinationPath === finalPath
          : mapping.destinationPath === finalPath);
      })) return 'unknown';
    }
    if (step.kind === 'delete') {
      let entry;
      for (let offset = 0; ; offset += 1000) {
        const entries = await listTrash({ workspace: input.scope.workspace, status: 'trashed', limit: 1000, offset });
        entry = entries.find((candidate) => candidate.id === receipt.trashEntryId && candidate.originalPath === step.sourcePath);
        if (entry || entries.length < 1000) break;
      }
      if (!entry) return 'unknown';
      const root = await fs.realpath(resolveWorkspaceDataRoot());
      const absolute = path.resolve(root, entry.trashRelativePath);
      if (!absolute.startsWith(`${root}${path.sep}`)) return 'unknown';
      return JSON.stringify(await treeAt(absolute)) === JSON.stringify(receipt.afterTree) ? 'after' : 'unknown';
    }
    const current = await pathTree(input.scope, step.destinationPath!);
    const expected = receipt.afterTree as TreeEntry[];
    if (!current || !Array.isArray(expected) || current.length !== expected.length) return 'unknown';
    return current.every((entry, ordinal) => {
      const prior = expected[ordinal];
      if (!prior || entry.path !== prior.path || entry.kind !== prior.kind) return false;
      const finalPath = entry.path === '.' ? step.destinationPath! : `${step.destinationPath}/${entry.path}`;
      const group = groupWorkspaceLinkWrites(manifest.plan.linkPlan).find((candidate) => candidate.path === finalPath);
      return group && entry.kind === 'file' ? entry.sha256 === group.beforeSha256 || entry.sha256 === group.afterSha256
        : entry.identity === prior.identity && entry.sha256 === prior.sha256;
    }) ? 'after' : 'unknown';
  };
  const withLock = <T>(scope: WorkspaceOperationBatchScope, operation: () => Promise<T>) => withWorkspaceMutationLock(scope.workspace.workspaceId,
    () => withWorkspaceCopyMutationLocks(scope.fileOptions, scope.fileOptions, operation));
  const assertUndoAvailable = async (input: { batchId: string; scope: WorkspaceOperationBatchScope }): Promise<void> => withLock(input.scope, async () => {
    const manifest = await load(input.batchId);
    const conflict = (code: string): never => { throw Object.assign(new Error(code), { status: 409, code }); };
    if (!manifest || manifest.workspaceId !== input.scope.workspace.workspaceId || manifest.status !== 'applied') return conflict('BATCH_UNDO_NOT_COMPLETE');
    const checked: UndoInput = { ...input, actorUserId: input.scope.workspace.actor?.userId ?? manifest.actorUserId, actorDisplayName: 'Undo review' };
    assertAccess(checked);
    for (const [index, step] of manifest.plan.pathSteps.entries()) {
      const occupied = await pathTree(input.scope, step.sourcePath);
      if (occupied && !manifest.plan.pathSteps.some((other) => other.kind !== 'delete'
        && samePath(step.sourcePath, other.destinationPath!))) conflict('BATCH_UNDO_DESTINATION_OCCUPIED');
      if (await pathProbe(checked, manifest, index) !== 'after') conflict('BATCH_UNDO_PATH_CHANGED');
    }
    for (const group of groupWorkspaceLinkWrites(manifest.plan.linkPlan)) {
      if (await probeLink(linkInput(checked, manifest), group, { preflight: manifest.linkPreflight ?? undefined }) !== 'after') conflict('BATCH_UNDO_LINK_CHANGED');
    }
    // Prove the complete inverse resolution graph, including backlinks created after apply
    // and aliases introduced when deleted Markdown is restored. No user document is rewritten here.
    const snapshot = await buildWorkspacePlannerSnapshot(manifest.workspaceId, input.scope.fileOptions);
    if (snapshot.entries.some((entry) => entry.omissionReason)) conflict('BATCH_UNDO_INDEX_INCOMPLETE');
    const currentSources = snapshot.entries.filter((entry) => entry.markdownContent !== undefined)
      .map((entry) => ({ path: entry.path, content: entry.markdownContent! }));
    const currentPaths = snapshot.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
    const currentIndex = buildWorkspaceLinkIndexFromDocuments(currentSources, new Date(0), currentPaths);
    if (currentIndex.unevaluatedLinks.length) conflict('BATCH_UNDO_INDEX_INCOMPLETE');
    const inversePaths = new Map(manifest.plan.pathMappings.map((mapping) => [mapping.destinationPath, mapping.sourcePath]));
    const editedPaths = new Map(manifest.plan.originalDocuments.map((document) => [
      manifest.plan.pathMappings.find((mapping) => mapping.sourcePath === document.path)?.destinationPath ?? document.path,
      document,
    ]));
    const restoredSources = currentSources.map((document) => ({ path: inversePaths.get(document.path) ?? document.path,
      content: editedPaths.get(document.path)?.content ?? document.content }));
    restoredSources.push(...(manifest.plan.deletedDocuments ?? []));
    const restoredPaths = [...currentPaths.map((current) => inversePaths.get(current) ?? current),
      ...manifest.plan.deletedPaths.filter((entry) => entry.kind === 'file').map((entry) => entry.path)];
    const restoredIndex = buildWorkspaceLinkIndexFromDocuments(restoredSources, new Date(0), restoredPaths);
    for (const document of currentSources.filter((source) => !editedPaths.has(source.path))) {
      const before = currentIndex.edges.filter((edge) => edge.sourcePath === document.path);
      const after = restoredIndex.edges.filter((edge) => edge.sourcePath === (inversePaths.get(document.path) ?? document.path));
      if (before.length !== after.length) conflict('BATCH_UNDO_NEW_BACKLINK');
      for (const [ordinal, edge] of before.entries()) {
        const next = after[ordinal];
        const expectedTarget = edge.targetPath ? inversePaths.get(edge.targetPath) ?? edge.targetPath : null;
        if (next.status !== edge.status || next.targetPath !== expectedTarget
          || JSON.stringify([...next.candidates].sort()) !== JSON.stringify(edge.candidates.map((candidate) => inversePaths.get(candidate) ?? candidate).sort())) {
          conflict('BATCH_UNDO_NEW_BACKLINK');
        }
      }
    }
  });

  const execute = async (input: ExecuteInput): Promise<WorkspaceOperationBatchExecutionResult> => withLock(input.scope, async () => {
    assertAccess(input);
    let manifest = await load(input.batchId);
    if (manifest && (manifest.workspaceId !== input.scope.workspace.workspaceId || manifest.actorUserId !== input.actorUserId
      || manifest.plan.planId !== input.plan.planId)) throw Object.assign(new Error('BATCH_ID_CONFLICT'), { status: 409 });
    if (manifest?.status === 'applied') return result(manifest);
    if (manifest && ['undoing', 'undone'].includes(manifest.status)) throw new Error('BATCH_ALREADY_REVERTED');
    try {
      if (!manifest) {
        if (input.plan.workspaceId !== input.scope.workspace.workspaceId || input.plan.readiness !== 'ready'
          || input.plan.issues.length || computeWorkspaceOperationBatchPlanId(input.plan) !== input.plan.planId) throw new Error('BATCH_PLAN_BLOCKED');
        const fresh = await rebuild({ scope: input.scope, actions: input.plan.actions });
        if (fresh.readiness !== 'ready' || fresh.planId !== input.plan.planId) throw Object.assign(new Error('BATCH_PLAN_STALE'), { status: 409 });
        manifest = { version: 1, batchId: input.batchId, workspaceId: fresh.workspaceId, actorUserId: input.actorUserId,
          plan: fresh, status: 'preparing', beforeTrees: {}, backupIds: [], linkPreflight: null, steps: [], undoSteps: [], undoPlan: null, undoPreflight: null, errorCode: null };
        for (const step of fresh.pathSteps) manifest.beforeTrees[step.sourcePath] = (await pathTree(input.scope, step.sourcePath))!;
        const groups = groupWorkspaceLinkWrites(fresh.linkPlan);
        manifest.linkPreflight = groups.length ? await preflight(linkInput(input, manifest)) : null;
        await progress(input, manifest, 'preparing');
        // Capture every destructive source and every backlink before the first mutation.
        const backupPaths = [...new Set([...fresh.pathSteps.map((step) => step.sourcePath), ...fresh.originalDocuments.map((doc) => doc.path)])]
          .filter((candidate, _, all) => !all.some((other) => candidate !== other && samePath(candidate, other)));
        for (const sourcePath of backupPaths) {
          const captured = await backup({ workspace: input.scope.workspace, path: sourcePath, operationId: input.batchId });
          manifest.backupIds.push(captured.backupId);
        }
        await save(manifest);
      }
      if (manifest.status === 'preparing' || manifest.status === 'failed' || manifest.status === 'needs_recovery') manifest.status = 'applying';
      if (!manifest.steps.some((step) => step.key.startsWith('path:') && step.receipt)) {
        const fresh = await rebuild({ scope: input.scope, actions: manifest.plan.actions });
        if (fresh.readiness !== 'ready' || fresh.planId !== manifest.plan.planId) throw new Error('BATCH_PLAN_STALE');
      }
      for (const [index, step] of manifest.plan.pathSteps.entries()) {
        const key = `path:${index}`;
        let durable = manifest.steps.find((entry) => entry.key === key);
        const observed = await pathProbe(input, manifest, index);
        if (durable?.state === 'applied') { if (observed !== 'after') throw new Error('BATCH_UNPROVEN_PATH_RECEIPT'); continue; }
        if (durable?.receipt && observed === 'after' && step.kind === 'delete') {
          await progress(input, manifest, 'paths');
          await archive({ workspace: input.scope.workspace, paths: [{ path: step.sourcePath, trashEntryId: String(durable.receipt.trashEntryId) }] });
          await sharesDeleted([step.sourcePath], input.scope.workspace);
          durable.state = 'applied'; await save(manifest); continue;
        }
        if (observed !== 'before') throw new Error('BATCH_UNPROVEN_PATH_INTENT');
        await progress(input, manifest, 'paths');
        if (!durable) { durable = { key, state: 'intent', receipt: null }; manifest.steps.push(durable); await save(manifest); }
        if (step.kind === 'delete') {
          const trashed = await trash({ workspace: input.scope.workspace, paths: [step.sourcePath], deletedByUserId: input.actorUserId });
          if (trashed.failed.length || trashed.trashed.length !== 1) throw new Error('BATCH_TRASH_FAILED');
          const entry = trashed.trashed[0];
          // Persist physical receipt before retrying idempotent projection services.
          durable.receipt = { trashEntryId: entry.id, afterTree: await treeAt(path.join(resolveWorkspaceDataRoot(), entry.trashRelativePath)) };
          await save(manifest);
          await archive({ workspace: input.scope.workspace, paths: [{ path: step.sourcePath, trashEntryId: entry.id }] });
          await sharesDeleted([step.sourcePath], input.scope.workspace);
        } else {
          const renamed = await rename({ workspace: input.scope.workspace, oldPath: step.sourcePath, newPath: step.destinationPath!, overwrite: false, fileOptions: input.scope.fileOptions });
          durable.receipt = { mutationId: renamed.mutation.operationId, afterTree: await pathTree(input.scope, step.destinationPath!) };
        }
        durable.state = 'applied';
        await save(manifest);
        if (await pathProbe(input, manifest, index) !== 'after') throw new Error('BATCH_UNPROVEN_PATH_RESULT');
      }
      for (const [index, group] of groupWorkspaceLinkWrites(manifest.plan.linkPlan).entries()) {
        const key = `link:${index}`;
        let durable = manifest.steps.find((entry) => entry.key === key);
        const observed = await probeLink(linkInput(input, manifest), group, { preflight: manifest.linkPreflight ?? undefined });
        if (observed === 'unknown' || durable?.state === 'applied' && observed !== 'after'
          || !durable && observed !== 'before') throw new Error('BATCH_UNPROVEN_LINK_STATE');
        if (durable?.state === 'applied') continue;
        await progress(input, manifest, 'links');
        if (!durable) { durable = { key, state: 'intent', receipt: null }; manifest.steps.push(durable); await save(manifest); }
        if (observed === 'before') durable.receipt = await applyLink(linkInput(input, manifest), group, { preflight: manifest.linkPreflight ?? undefined });
        if (await probeLink(linkInput(input, manifest), group, { preflight: manifest.linkPreflight ?? undefined }) !== 'after') throw new Error('BATCH_UNPROVEN_LINK_RESULT');
        durable.state = 'applied'; await save(manifest);
      }
      for (const group of groupWorkspaceLinkWrites(manifest.plan.linkPlan)) {
        await progress(input, manifest, 'links');
        const documentId = manifest.linkPreflight?.sources.find((source) => source.sourcePathBefore === group.sourcePathBefore)?.documentId ?? null;
        await checkpointLink(linkInput(input, manifest), group, documentId);
      }
      // Completion also proves the serialized checkpoint and the final path receipts.
      const checkpointDeadline = Date.now() + 10_000;
      while (true) {
        let checkpointReady = true;
        for (const document of manifest.plan.previewContents) {
          try {
            const bytes = await fs.readFile(await resolveExistingWorkspacePath(document.path, input.scope.fileOptions));
            if (digest(bytes) !== digest(document.content)) checkpointReady = false;
          } catch { checkpointReady = false; }
        }
        if (checkpointReady) {
          for (const [index] of manifest.plan.pathSteps.entries()) {
            if (await pathProbe(input, manifest, index) !== 'after') throw new Error('BATCH_FINAL_PATH_CHANGED');
          }
          for (const group of groupWorkspaceLinkWrites(manifest.plan.linkPlan)) {
            if (await probeLink(linkInput(input, manifest), group, { preflight: manifest.linkPreflight ?? undefined }) !== 'after') throw new Error('BATCH_FINAL_LINK_CHANGED');
          }
          break;
        }
        if (Date.now() >= checkpointDeadline) throw new Error('BATCH_CHECKPOINT_PENDING');
        await progress(input, manifest, 'links');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const finalSnapshot = await buildWorkspacePlannerSnapshot(manifest.workspaceId, input.scope.fileOptions);
      const finalPlan = manifest.plan;
      const initialSourceFor = (finalPath: string) => finalPlan.pathMappings.find((mapping) => mapping.destinationPath === finalPath)?.sourcePath ?? finalPath;
      if (finalSnapshot.entries.some((entry) => entry.omissionReason
        && !finalPlan.coverage.omittedSources.some((known) => known.path === initialSourceFor(entry.path)))) {
        throw new Error('BATCH_FINAL_INDEX_INCOMPLETE');
      }
      const finalIndex = buildWorkspaceLinkIndexFromDocuments(finalSnapshot.entries.filter((entry) => entry.markdownContent !== undefined)
        .map((entry) => ({ path: entry.path, content: entry.markdownContent! })), new Date(0),
      finalSnapshot.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
      if (finalIndex.unevaluatedLinks.some((entry) => !finalPlan.coverage.unresolvedLinks.some((known) =>
        known.sourcePath === initialSourceFor(entry.sourcePath) && known.targetLiteral === entry.raw && known.status === 'not-evaluated'))) {
        throw new Error('BATCH_FINAL_INDEX_INCOMPLETE');
      }
      const oldRoots = finalPlan.pathSteps.map((step) => step.sourcePath);
      for (const edge of finalIndex.edges.filter((candidate) => candidate.status !== 'resolved')) {
        const initialSource = manifest.plan.pathMappings.find((mapping) => mapping.destinationPath === edge.sourcePath)?.sourcePath ?? edge.sourcePath;
        const knownWarning = manifest.plan.coverage.unresolvedLinks.some((warning) => warning.sourcePath === initialSource
          && warning.targetLiteral === edge.targetLiteral && warning.status === edge.status);
        if (knownWarning) continue;
        const parsed = edge.kind === 'markdown' ? parseWorkspaceMarkdownHref(edge.targetLiteral) : null;
        const exact = parsed && path.posix.normalize(parsed.path.startsWith('/') ? parsed.path.slice(1)
          : path.posix.join(path.posix.dirname(edge.sourcePath), parsed.path));
        const oldWikiName = edge.kind === 'wiki' && oldRoots.some((root) => edge.targetText.split('#')[0].toLocaleLowerCase()
          === path.posix.basename(root).replace(/\.(?:md|markdown)$/iu, '').toLocaleLowerCase());
        if (exact && oldRoots.some((root) => samePath(exact, root)) || oldWikiName
          || edge.candidates.some((candidate) => finalPlan.pathMappings.some((mapping) => mapping.destinationPath === candidate))) {
          throw new Error('BATCH_FINAL_NEW_BACKLINK');
        }
      }
      manifest.status = 'applied'; manifest.errorCode = null; await save(manifest);
      await progress(input, manifest, 'complete');
      return result(manifest);
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 160) : 'BATCH_EXECUTION_FAILED';
      if (!manifest) return { status: 'failed', trashEntryIds: [], completedActions: 0,
        totalActions: input.plan.pathSteps.length + input.plan.previewContents.length, errorCode: code };
      manifest.status = manifest.steps.length ? 'needs_recovery' : 'failed'; manifest.errorCode = code;
      await save(manifest).catch(() => undefined);
      return result(manifest);
    }
  });

  const undo = async (input: UndoInput): Promise<WorkspaceOperationBatchExecutionResult> => withLock(input.scope, async () => {
    assertAccess(input);
    const manifest = await load(input.batchId);
    if (!manifest || manifest.workspaceId !== input.scope.workspace.workspaceId) throw new Error('BATCH_ID_CONFLICT');
    if (manifest.status === 'undone') return result(manifest);
    try {
      if (!manifest.undoPlan) {
        if (manifest.status !== 'applied') throw new Error('BATCH_UNDO_NOT_COMPLETE');
        await assertUndoAvailable({ batchId: input.batchId, scope: input.scope });
        for (const [index] of manifest.plan.pathSteps.entries()) if (await pathProbe(input, manifest, index) !== 'after') throw new Error('BATCH_UNDO_PATH_CHANGED');
        const originalGroups = groupWorkspaceLinkWrites(manifest.plan.linkPlan);
        for (const group of originalGroups) if (await probeLink(linkInput(input, manifest), group, { preflight: manifest.linkPreflight ?? undefined }) !== 'after') throw new Error('BATCH_UNDO_LINK_CHANGED');
        const mappings = [];
        const expected = [];
        const edits = [];
        const contents = [];
        for (const group of originalGroups) {
          const stat = await fs.stat(await resolveExistingWorkspacePath(group.path, input.scope.fileOptions));
          mappings.push({ sourceWorkspaceId: manifest.workspaceId, destinationWorkspaceId: manifest.workspaceId,
            sourcePath: group.path, destinationPath: group.path, sourceIdentity: filesystemFileVersion(stat) });
          expected.push({ workspaceId: manifest.workspaceId, path: group.path, identity: filesystemFileVersion(stat), contentHash: group.afterSha256 });
          const original = manifest.plan.originalDocuments.find((doc) => doc.path === group.sourcePathBefore)!.content;
          edits.push({ sourceWorkspaceId: manifest.workspaceId, destinationWorkspaceId: manifest.workspaceId,
            sourcePathBefore: group.path, sourcePathAfter: group.path, expectedContentHash: group.afterSha256,
            previousTargetLiteral: group.afterContent, nextTargetLiteral: original,
            targetRange: { startUtf16: 0, endUtf16: group.afterContent.length, startUtf8Byte: 0, endUtf8Byte: Buffer.byteLength(group.afterContent) } });
          contents.push({ workspaceId: manifest.workspaceId, path: group.path, content: original });
        }
        const raw = { ...manifest.plan.linkPlan, pathMappings: mappings, expectedPathState: expected,
          linkEdits: edits, previewContents: contents, coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
          linkAssessment: { version: 1 as const, complete: true, warnings: [], blockers: [] } };
        manifest.undoPlan = { ...raw, planId: computeWorkspaceFileOperationPlanId(raw) };
        manifest.undoPreflight = edits.length ? await preflight(linkInput(input, manifest, true)) : null;
        manifest.status = 'undoing'; await save(manifest);
      }
      for (const [index, group] of groupWorkspaceLinkWrites(manifest.undoPlan).entries()) {
        const key = `link:${index}`;
        let durable = manifest.undoSteps.find((step) => step.key === key);
        const recovered = recoveredUndoLinks(input, manifest);
        const located = recovered.groups.find((candidate) => candidate.sourcePathBefore === group.sourcePathBefore)!;
        const observed = await probeLink(recovered.input, located, { preflight: recovered.preflight });
        if (observed === 'unknown' || durable?.state === 'applied' && observed !== 'after' || !durable && observed !== 'before') throw new Error('BATCH_UNDO_LINK_CHANGED');
        if (durable?.state === 'applied') continue;
        await progress(input, manifest, 'recovery');
        if (!durable) { durable = { key, state: 'intent', receipt: null }; manifest.undoSteps.push(durable); await save(manifest); }
        if (observed === 'before') durable.receipt = await applyLink(linkInput(input, manifest, true), group, { preflight: manifest.undoPreflight ?? undefined });
        if (await probeLink(linkInput(input, manifest, true), group, { preflight: manifest.undoPreflight ?? undefined }) !== 'after') throw new Error('BATCH_UNDO_LINK_RESULT_UNPROVEN');
        durable.state = 'applied'; await save(manifest);
      }
      const checkpointRecovered = recoveredUndoLinks(input, manifest);
      for (const group of checkpointRecovered.groups) {
        await progress(input, manifest, 'recovery');
        const documentId = checkpointRecovered.preflight?.sources.find((source) => source.sourcePathBefore === group.sourcePathBefore)?.documentId ?? null;
        await checkpointLink(checkpointRecovered.input, group, documentId);
      }
      const undoCheckpointDeadline = Date.now() + 10_000;
      while (true) {
        const recovered = recoveredUndoLinks(input, manifest);
        const ready = await Promise.all(recovered.input.plan.previewContents.map(async (document) => {
          try { return digest(await fs.readFile(await resolveExistingWorkspacePath(document.path, input.scope.fileOptions))) === digest(document.content); }
          catch { return false; }
        }));
        if (ready.every(Boolean)) break;
        if (Date.now() >= undoCheckpointDeadline) throw new Error('BATCH_UNDO_CHECKPOINT_PENDING');
        await progress(input, manifest, 'recovery'); await new Promise((resolve) => setTimeout(resolve, 200));
      }
      for (const [index, step] of [...manifest.plan.pathSteps.entries()].reverse()) {
        const key = `path:${index}`;
        const applied = manifest.steps.find((candidate) => candidate.key === key)!;
        let durable = manifest.undoSteps.find((candidate) => candidate.key === key);
        if (durable?.receipt) {
          const restored = await pathTree(input.scope, step.sourcePath);
          if (JSON.stringify(restored) !== JSON.stringify(durable.receipt.afterTree)) throw new Error('BATCH_UNDO_PATH_CHANGED');
          if (durable.state === 'applied') continue;
          if (step.kind !== 'delete') throw new Error('BATCH_UNDO_PATH_INTENT_UNPROVEN');
          await progress(input, manifest, 'recovery');
          await restoreCollaboration({ workspace: input.scope.workspace, path: step.sourcePath, trashEntryId: String(durable.receipt.trashEntryId) });
          durable.state = 'applied'; await save(manifest); continue;
        }
        if (durable) throw new Error('BATCH_UNDO_PATH_INTENT_UNPROVEN');
        if (await pathTree(input.scope, step.sourcePath) !== null) throw new Error('BATCH_UNDO_DESTINATION_OCCUPIED');
        await progress(input, manifest, 'recovery');
        durable = { key, state: 'intent', receipt: null }; manifest.undoSteps.push(durable); await save(manifest);
        if (step.kind === 'delete') {
          const entry = await restoreTrash({ workspace: input.scope.workspace, entryId: String(applied.receipt!.trashEntryId), restoredByUserId: input.actorUserId, overwrite: false });
          durable.receipt = { trashEntryId: entry.id, afterTree: await pathTree(input.scope, step.sourcePath) };
          await save(manifest);
          await restoreCollaboration({ workspace: input.scope.workspace, path: entry.originalPath, trashEntryId: entry.id });
        } else {
          const reverted = await rename({ workspace: input.scope.workspace, oldPath: step.destinationPath!, newPath: step.sourcePath, overwrite: false, fileOptions: input.scope.fileOptions });
          durable.receipt = { mutationId: reverted.mutation.operationId, afterTree: await pathTree(input.scope, step.sourcePath) };
        }
        const restored = await pathTree(input.scope, step.sourcePath);
        const before = manifest.beforeTrees[step.sourcePath];
        if (!restored || restored.length !== before.length || restored.some((entry, ordinal) => entry.path !== before[ordinal].path || entry.kind !== before[ordinal].kind || entry.sha256 !== before[ordinal].sha256)) throw new Error('BATCH_UNDO_RESULT_UNPROVEN');
        durable.state = 'applied'; await save(manifest);
        await progress(input, manifest, 'recovery');
      }
      const recovered = recoveredUndoLinks(input, manifest);
      for (const group of recovered.groups) if (await probeLink(recovered.input, group, { preflight: recovered.preflight }) !== 'after') throw new Error('BATCH_UNDO_FINAL_LINK_CHANGED');
      manifest.status = 'undone'; manifest.errorCode = null; await save(manifest); return result(manifest);
    } catch (error) {
      manifest.errorCode = error instanceof Error ? error.message.slice(0, 160) : 'BATCH_UNDO_FAILED';
      // Keep the forward receipt complete when a preflight-only undo was refused.
      if (manifest.undoSteps.length || manifest.undoPlan) manifest.status = 'undoing';
      await save(manifest);
      return { ...result(manifest), status: 'needs_recovery' };
    }
  });

  return { execute, undo, assertUndoAvailable,
    async has(batchId: string, workspaceId?: string): Promise<boolean> {
      const manifest = await load(batchId); return Boolean(manifest && (!workspaceId || manifest.workspaceId === workspaceId));
    },
    async get(input: { batchId: string; scope: WorkspaceOperationBatchScope }): Promise<WorkspaceOperationBatchExecutionResult | null> {
      const manifest = await load(input.batchId);
      if (!manifest || manifest.workspaceId !== input.scope.workspace.workspaceId || !input.scope.workspace.permissions.canRead) return null;
      return result(manifest);
    },
  };
}

// Resolve DATA on each entry so test/dev environment setup may happen after module import.
export const executeWorkspaceOperationBatch = (input: ExecuteInput) => createWorkspaceOperationBatchExecutor().execute(input);
export const undoWorkspaceOperationBatch = (input: UndoInput) => createWorkspaceOperationBatchExecutor().undo(input);
export const hasWorkspaceOperationBatchExecution = (batchId: string, workspaceId?: string) => createWorkspaceOperationBatchExecutor().has(batchId, workspaceId);
export const getWorkspaceOperationBatchExecution = (input: { batchId: string; scope: WorkspaceOperationBatchScope }) => createWorkspaceOperationBatchExecutor().get(input);
export const assertWorkspaceOperationBatchUndoAvailable = (input: { batchId: string; scope: WorkspaceOperationBatchScope }) => createWorkspaceOperationBatchExecutor().assertUndoAvailable(input);
