import 'server-only';

import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { withWorkspaceRequestPrincipalOriginalOrigin, withWorkspaceRequestPrincipalOnConnection,
  type WorkspaceRequestHistoricalOrigin, type WorkspaceRequestPrincipalAccess } from '@/app/lib/workspaces/request-principal';
import { requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { readWorkspaceDocumentCatalogue } from '@/app/lib/collaboration/workspace-document-catalogue';
import { authoritativeNativeCollaborationSnapshot, type NativeCollaborationContent } from '@/app/lib/collaboration/document-snapshot';
import { readNativeWorkspaceRecoveryRecords } from '@/app/lib/collaboration/workspace-native-recovery';
import { persistPristineOriginalWorkspaceFileForWrite, type PristineOriginalWorkspaceFileRequest,
  type PristineOriginalRequestScopeExpectation } from '@/app/lib/collaboration/markdown-file-import-persistence';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { captureNativeWorkspaceOperationBackup } from '@/app/lib/files/workspace-operation-backup';
import { withWorkspaceSideEffectWriterFenceOnConnection, type WorkspaceSideEffectWriterTarget } from '@/app/lib/files/workspace-side-effect-writer-fence';
import type { WorkspaceFileMetadataTarget } from '@/app/lib/files/workspace-file-metadata-contract';
import { filesystemFileVersion } from '@/app/lib/filesystem/file-version';
import { isInternalWorkspaceStagingPath } from '@/app/lib/files/internal-staging-path';
import { assertWorkspaceOriginalPathCurrent, WorkspaceOriginalFileSourceError,
  type WorkspaceOriginalPathObservation } from '@/app/lib/files/workspace-original-file-source';
import { isSensitiveWorkspacePath } from '@/app/lib/public-sharing/public-file-shares';
import { collectPublicMarkdownImageWorkspacePaths, resolvePublicMarkdownImageWorkspacePath } from '@/app/lib/public-sharing/public-markdown-images';
import { captureFileGuestTarget, readFileGuestNativeTargetOnConnection, FileGuestTargetError } from './target';
import { FILE_GUEST_CONTENT_LIMIT } from './content-contract';
import type { FileGuestAsset } from './types';

type NativeInfoTarget = Extract<WorkspaceFileMetadataTarget, { kind: 'native_file' }>;
export type FileGuestInvitationPreparationSelection = Readonly<{
  workspaceId: string; path: string; expectedTarget: unknown; operationId: string;
}>;
export type PreparedFileGuestInvitation = Readonly<{
  workspaceId: string; path: string; target: NativeInfoTarget; assets: readonly Readonly<FileGuestAsset>[]; backupId: string;
  /** Rejection check only. The member writer owns B's genuine Principal and Shared authority. */
  assertCurrent: (database?: SqlConnection) => Promise<void>;
}>;
type Dependencies = { openConnection: () => Promise<SqlConnection> };
type AssetObservation = { asset: Readonly<FileGuestAsset>; version: string; root: string; rootIdentity: string; ancestry: string[] };
const ASSET_LIMIT = 100, ASSET_BYTES = 20 * 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const physicalIdentity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

export class FileGuestPreparationError extends Error {
  constructor(readonly code: 'FILE_GUEST_PREPARATION_INVALID' | 'FILE_GUEST_PREPARATION_DENIED'
    | 'FILE_GUEST_PREPARATION_CHANGED' | 'FILE_GUEST_ASSET_CHANGED' | 'FILE_GUEST_PREPARATION_UNCONFIRMED'
    | 'FILE_GUEST_PREPARATION_TOO_LARGE') { super(code); this.name = 'FileGuestPreparationError'; }
  get status() { return this.code === 'FILE_GUEST_PREPARATION_INVALID' ? 400 : this.code === 'FILE_GUEST_PREPARATION_DENIED' ? 403
    : this.code === 'FILE_GUEST_PREPARATION_UNCONFIRMED' ? 503 : this.code === 'FILE_GUEST_PREPARATION_TOO_LARGE' ? 413 : 409; }
}
const fail = (code: FileGuestPreparationError['code']): never => { throw new FileGuestPreparationError(code); };

function selection(input: FileGuestInvitationPreparationSelection) {
  const keys = ['workspaceId', 'path', 'expectedTarget', 'operationId'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
    || keys.some(key => { const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'); })
    || typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.operationId)
    || !isCanonicalAdmissionPath(input.path) || isInternalWorkspaceStagingPath(input.path) || isSensitiveWorkspacePath(input.path)) fail('FILE_GUEST_PREPARATION_INVALID');
  return Object.freeze({ workspaceId: input.workspaceId, path: input.path, operationId: input.operationId,
    expectedTarget: captureFileGuestTarget(input.expectedTarget, input.workspaceId, input.path) });
}

function assertOrigin(origin: WorkspaceRequestHistoricalOrigin, access: WorkspaceRequestPrincipalAccess): void {
  if (origin.userId !== access.userId || origin.sessionId !== access.sessionId
    || ['workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status']
      .some(key => (Reflect.get(origin, key) ?? null) !== (Reflect.get(access.workspace, key) ?? null))) fail('FILE_GUEST_PREPARATION_CHANGED');
}

async function assertRealm(database: SqlConnection, origin: WorkspaceRequestHistoricalOrigin): Promise<void> {
  const actual = await database.get(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,current_setting('search_path') AS search_path,
    w.type,w.organization_id,w.customer_id,w.project_id,w.owner_user_id,w.root_relative_path,w.status
    FROM canvas_workspaces w WHERE w.id=$1`, [origin.workspaceId]) as Record<string, unknown> | undefined;
  if (!actual || actual.schema !== origin.schema || Number(actual.schema_oid) !== origin.schemaOid
    || Number(actual.database_oid) !== origin.databaseOid || actual.search_path !== origin.searchPath
    || actual.type !== origin.workspaceType || actual.organization_id !== origin.organizationId || actual.customer_id !== origin.customerId
    || actual.project_id !== origin.projectId || actual.owner_user_id !== origin.ownerUserId
    || actual.root_relative_path !== origin.rootRelativePath || actual.status !== origin.status) fail('FILE_GUEST_PREPARATION_CHANGED');
}

async function memberRead<T>(request: NextRequest, workspaceId: string, permission: 'canRead' | 'canWrite', dependencies: Dependencies,
  operation: (database: SqlConnection, access: WorkspaceRequestPrincipalAccess) => Promise<T>,
  expectedOrigin?: WorkspaceRequestHistoricalOrigin): Promise<{ value: T; origin: WorkspaceRequestHistoricalOrigin }> {
  let origin: WorkspaceRequestHistoricalOrigin | undefined;
  const value = await withWorkspaceRequestPrincipalOriginalOrigin(request, { workspaceId, permission }, actual => { origin = actual; }, principal =>
    executeLifecycleTransaction({ openConnection: dependencies.openConnection,
      execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
        return withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
          if (!origin || !access.workspace.permissions.canCreatePublicLinks) fail('FILE_GUEST_PREPARATION_DENIED');
          if (expectedOrigin && Object.keys(expectedOrigin).some(key => Reflect.get(origin!, key) !== Reflect.get(expectedOrigin, key))) fail('FILE_GUEST_PREPARATION_CHANGED');
          const result = await operation(database, access); await access.assertCurrent(); return result;
        });
      },
      recoverCommitted: async () => fail('FILE_GUEST_PREPARATION_UNCONFIRMED'),
    }));
  if (!origin) throw new FileGuestPreparationError('FILE_GUEST_PREPARATION_UNCONFIRMED');
  return { value, origin };
}

function bootstrapOrigin(origin: WorkspaceRequestHistoricalOrigin): PristineOriginalRequestScopeExpectation {
  const { impersonatedBy, ...expected } = origin; void impersonatedBy;
  return expected as PristineOriginalRequestScopeExpectation;
}

function imagePaths(content: NativeCollaborationContent, filePath: string, workspaceId: string): string[] {
  const paths = content.kind === 'plain_text' ? collectPublicMarkdownImageWorkspacePaths(content.text, filePath, workspaceId) : new Set<string>();
  if (content.kind === 'rich_text') {
    const pending = [content.document]; let nodes = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (++nodes > 100_000) fail('FILE_GUEST_PREPARATION_TOO_LARGE');
      if (node.type === 'image' && typeof node.attrs?.src === 'string') {
        const resolved = resolvePublicMarkdownImageWorkspacePath(filePath, node.attrs.src, workspaceId);
        if (resolved) paths.add(resolved);
      }
      pending.push(...(node.content ?? []));
    }
  }
  if (paths.size > ASSET_LIMIT) fail('FILE_GUEST_PREPARATION_TOO_LARGE');
  return [...paths].filter(candidate => isCanonicalAdmissionPath(candidate) && !isSensitiveWorkspacePath(candidate)).sort();
}

async function readNativeContent(database: SqlConnection, workspace: WorkspaceContext, target: WorkspaceSideEffectWriterTarget) {
  const current = await readFileGuestNativeTargetOnConnection(database, workspace, target);
  if (current.lineageId !== target.lineageId || current.representation !== target.representation || current.schemaVersion !== target.schemaVersion) {
    throw new FileGuestTargetError('FILE_GUEST_TARGET_CHANGED');
  }
  const records = await readNativeWorkspaceRecoveryRecords(database, workspace, target.path);
  if (records.length !== 1 || records[0].lineageId !== target.lineageId || records[0].state.documentId !== target.documentId
    || records[0].state.lifecycleGeneration !== target.lifecycleGeneration) throw new FileGuestTargetError('FILE_GUEST_TARGET_CHANGED');
  const content = authoritativeNativeCollaborationSnapshot(records[0].state).content;
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > FILE_GUEST_CONTENT_LIMIT) fail('FILE_GUEST_PREPARATION_TOO_LARGE');
  return content;
}

async function observeAsset(workspace: WorkspaceContext, assetPath: string): Promise<AssetObservation | null> {
  const root = await fs.realpath(workspace.rootPath), rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) fail('FILE_GUEST_ASSET_CHANGED');
  let parent = root, relativePath = ''; const ancestry: string[] = [];
  const entries = new Map<string, WorkspaceOriginalPathObservation>();
  const segments = assetPath.split('/');
  try {
    for (let index = 0; index < segments.length; index++) {
      const candidate = path.join(parent, segments[index]), stat = await fs.lstat(candidate);
      relativePath = relativePath ? `${relativePath}/${segments[index]}` : segments[index];
      entries.set(relativePath, { relativePath, stat, identity: filesystemFileVersion(stat) });
      if (stat.isSymbolicLink() || !(await fs.readdir(parent)).includes(segments[index])) return null;
      if (index < segments.length - 1) {
        if (!stat.isDirectory()) return null;
        ancestry.push(physicalIdentity(stat)); parent = candidate; continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size > ASSET_BYTES) return null;
      const handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const source = { configuredRootPath: workspace.rootPath, root: { resolvedRootPath: root, identity: filesystemFileVersion(rootStat), entries },
          observed: entries.get(assetPath)! };
        await assertWorkspaceOriginalPathCurrent(source);
        const before = await handle.stat(), current = await fs.lstat(candidate);
        await assertWorkspaceOriginalPathCurrent(source);
        const after = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > ASSET_BYTES || !Number.isSafeInteger(before.size)
          || filesystemFileVersion(stat) !== filesystemFileVersion(before) || current.isSymbolicLink()
          || filesystemFileVersion(current) !== filesystemFileVersion(before) || filesystemFileVersion(after) !== filesystemFileVersion(before)) return null;
        return { asset: Object.freeze({ path: assetPath, identity: physicalIdentity(before) }), version: filesystemFileVersion(before),
          root, rootIdentity: physicalIdentity(rootStat), ancestry };
      } finally { await handle.close(); }
    }
  } catch (error) {
    if (error instanceof WorkspaceOriginalFileSourceError) fail('FILE_GUEST_ASSET_CHANGED');
    if (error && typeof error === 'object' && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(String(Reflect.get(error, 'code')))) return null;
    throw error;
  }
  return null;
}

/** Holds the actual workspace kernel across native/physical preparation, private
 * baseline publication and the awaited member-writer callback through COMMIT.
 * Prepared observations grant no ACL, SQL connection, content session or write. */
export async function withPreparedFileGuestInvitation<T>(request: NextRequest, input: FileGuestInvitationPreparationSelection,
  operation: (prepared: PreparedFileGuestInvitation) => Promise<T>, dependencies: Dependencies = { openConnection: openDb }): Promise<T> {
  const selected = selection(input);
  if (!(request instanceof NextRequest) || typeof operation !== 'function' || typeof dependencies.openConnection !== 'function') fail('FILE_GUEST_PREPARATION_INVALID');
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  return withWorkspaceMutationLock(selected.workspaceId, async () => {
    await requireTeamRuntimeLicense();
    let target: NativeInfoTarget, native: WorkspaceSideEffectWriterTarget;
    const initial = await memberRead(original, selected.workspaceId, selected.expectedTarget.kind === 'filesystem' ? 'canWrite' : 'canRead', dependencies,
      async (database, access) => {
        if (selected.expectedTarget.kind === 'native_file') {
          const native = await readFileGuestNativeTargetOnConnection(database, access.workspace, selected.expectedTarget);
          await withWorkspaceSideEffectWriterFenceOnConnection(database, { workspace: access.workspace, targets: [native] }, async () => undefined);
          return { kind: 'native' as const, target: selected.expectedTarget, native };
        }
        if (!/\.(?:md|markdown)$/iu.test(selected.path)) fail('FILE_GUEST_PREPARATION_INVALID');
        const documents = await readWorkspaceDocumentCatalogue(database, access.workspace, { paths: [selected.path], maxEntries: 2 });
        const document = documents[0];
        if (documents.length > 1 || document && (document.path !== selected.path || document.authority !== 'pristine')) {
          throw new FileGuestTargetError('FILE_GUEST_TARGET_CHANGED');
        }
        const expectedTarget: PristineOriginalWorkspaceFileRequest['expectedTarget'] = document
          ? { kind: 'pristine', documentId: document.id } : { kind: 'absent' };
        return { kind: 'physical' as const, expectedTarget };
      });
    if (initial.value.kind === 'physical') {
      const actualTarget = selected.expectedTarget;
      if (actualTarget.kind !== 'filesystem') throw new FileGuestPreparationError('FILE_GUEST_PREPARATION_INVALID');
      const operationId = `guest-initialize-${digest(JSON.stringify([selected.workspaceId, selected.path, selected.operationId]))}`;
      const imported = await persistPristineOriginalWorkspaceFileForWrite(original, { workspaceId: selected.workspaceId, path: selected.path,
        operationId, requestId: operationId, expectedTarget: initial.value.expectedTarget, expectedFileVersion: actualTarget.fileVersion },
      { ...dependencies, expectedRequestScope: bootstrapOrigin(initial.origin) });
      const result = imported.receipt.target;
      target = captureFileGuestTarget({ version: 1, kind: 'native_file', workspaceId: result.workspaceId, path: result.path,
        documentId: result.documentId, lifecycleGeneration: result.lifecycleGeneration }, selected.workspaceId, selected.path) as NativeInfoTarget;
      native = { kind: 'native_file', documentId: result.documentId, workspaceId: result.workspaceId, path: result.path,
        organizationId: result.organizationId, lineageId: result.lineageId, lifecycleGeneration: result.lifecycleGeneration,
        representation: result.representation, schemaVersion: result.schemaVersion };
    } else { target = initial.value.target; native = initial.value.native; }
    const baseline = await captureNativeWorkspaceOperationBackup(original, { workspaceId: selected.workspaceId, path: selected.path,
      expectedTarget: target, operationId: `guest-baseline-${digest(JSON.stringify([selected.workspaceId, selected.path, selected.operationId]))}` }, dependencies);
    const snapshot = await memberRead(original, selected.workspaceId, 'canRead', dependencies, async (database, access) => {
      assertOrigin(initial.origin, access); await assertRealm(database, initial.origin);
      return withWorkspaceSideEffectWriterFenceOnConnection(database, { workspace: access.workspace, targets: [native] }, async () =>
        ({ workspace: access.workspace, content: await readNativeContent(database, access.workspace, native) }));
    }, initial.origin);
    const paths = imagePaths(snapshot.value.content, selected.path, selected.workspaceId);
    const observations: AssetObservation[] = [];
    for (const assetPath of paths) { const observed = await observeAsset(snapshot.value.workspace, assetPath); if (observed) observations.push(observed); }
    let active = true;
    const assertCurrent = async (database?: SqlConnection) => {
      if (!active) fail('FILE_GUEST_PREPARATION_CHANGED');
      if (database) {
        await assertRealm(database, initial.origin);
        const content = await readNativeContent(database, snapshot.value.workspace, native);
        if (JSON.stringify(imagePaths(content, selected.path, selected.workspaceId)) !== JSON.stringify(paths)) fail('FILE_GUEST_ASSET_CHANGED');
      }
      for (const expected of observations) {
        const actual = await observeAsset(snapshot.value.workspace, expected.asset.path);
        if (!actual || actual.asset.identity !== expected.asset.identity || actual.version !== expected.version || actual.root !== expected.root
          || actual.rootIdentity !== expected.rootIdentity || JSON.stringify(actual.ancestry) !== JSON.stringify(expected.ancestry)) fail('FILE_GUEST_ASSET_CHANGED');
      }
      if (!active) fail('FILE_GUEST_PREPARATION_CHANGED');
    };
    const prepared = Object.freeze({ workspaceId: selected.workspaceId, path: selected.path, target: Object.freeze({ ...target }),
      assets: Object.freeze(observations.map(observation => observation.asset)), backupId: baseline.backupId, assertCurrent });
    try { await assertCurrent(); return await operation(prepared); }
    finally { active = false; }
  });
}
