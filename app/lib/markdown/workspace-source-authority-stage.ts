import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';
import { openDb, type SqlConnection } from '../db';
import { loadCollaborationStateOnConnection } from '../collaboration/persistence';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { readWorkspaceDocumentCatalogue } from '../collaboration/workspace-document-catalogue';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { assertWorkspaceOriginalPathCurrent, readWorkspaceOriginalFileSource, WorkspaceOriginalFileSourceError,
  type WorkspaceOriginalPathObservation, type WorkspaceOriginalRootObservation } from '../files/workspace-original-file-source';
import { filesystemFileVersion } from '../filesystem/file-version';
import { assertWorkspacePathHasNoAliases } from '../workspaces/path-guard';
import type { WorkspaceContext } from '../workspaces/types';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeNamespaceEntry } from './workspace-link-contract-v2';
import { inspectOriginalPhysicalLinks, workspaceSourceAuthorityStageProof, type PhysicalSourceGap,
  type WorkspaceSourceAuthorityStage } from './workspace-physical-link-inventory';

type Limits = { maxPaths: number; maxDepth: number; maxSourceBytes: number; maxTotalSourceBytes: number; maxLinks: number };
type Dependencies = {
  openConnection?: () => Promise<SqlConnection>;
  loadState?: typeof loadCollaborationStateOnConnection;
  /** Fault-injection seam: authority/path/inode are rechecked AFTER this await. */
  afterSourceFingerprint?: (relativePath: string) => Promise<void>;
  limits?: Partial<Limits>;
};
const DEFAULT_LIMITS: Limits = { maxPaths: 10_000, maxDepth: 32, maxSourceBytes: MAX_INDEXED_MARKDOWN_BYTES,
  maxTotalSourceBytes: 32 * 1024 * 1024, maxLinks: 20_000 };
// Same visible-workspace domain as workspace-files/listDirectory. Exclusions
// are explicit in the stage scope; ignored internal backups are not link sources.
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache', '.canvas-brand', '.canvas-copy-backups']);
const EXCLUDED_FILES = new Set(['.gitkeep', '.keep']);
class PhysicalStageConflict extends Error {
  constructor(readonly code: string, readonly filePath: string) { super(code); }
}
const fail = (code: string, filePath: string): never => { throw new PhysicalStageConflict(code, filePath); };

/** Private, bounded original-byte stage. The shared workspace admission fence
 * covers catalogue classification, filesystem inventory, every read and final
 * proof checks. No initialization, serializer, file write or mutation admission
 * occurs. A later coordinator must import/rebind under its real mutation fence.
 * This standalone reader owns a fresh connection: run it BEFORE any exclusive
 * DA04/kernel/lifecycle admission, never beneath a lease on another backend.
 * Its historical SourceProof must be freshly confirmed through a scoped
 * same-connection mutation capability before import; it grants no authority.
 */
export async function stageWorkspaceLinkSourceAuthority(workspace: WorkspaceContext, dependencies: Dependencies = {}): Promise<WorkspaceSourceAuthorityStage> {
  workspace = structuredClone(workspace);
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') throw Object.assign(new Error('Current workspace read permission is required.'), { status: 403 });
  const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  if (Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof Limits])) throw new Error('Invalid physical source staging limit.');
  const sources: WorkspaceSourceAuthorityStage['sources'] = []; const namespace = new Map<string, NativeNamespaceEntry>();
  const gaps: PhysicalSourceGap[] = []; const excludedPaths: string[] = []; const observed: WorkspaceOriginalPathObservation[] = [];
  let catalogueProof: string | null = null; let connection: SqlConnection | undefined; let transaction = false; let discard: Error | undefined;
  const gap = (code: string, filePath: string) => gaps.push({ code, path: filePath });
  let totalBytes = 0; let totalLinks = 0;
  try {
    connection = await (dependencies.openConnection ?? openDb)();
    await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'); transaction = true;
    await connection.run("SET LOCAL statement_timeout='5s'"); await connection.run("SET LOCAL lock_timeout='4s'");
    await connection.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
    const catalogue = await readWorkspaceDocumentCatalogue(connection, workspace);
    if (catalogue.length > limits.maxPaths) fail('path-count-limit', '');
    catalogueProof = nativeLinkJsonProof(catalogue);
    const registered = new Map(catalogue.map((entry) => [entry.path, entry]));
    const verifyPhysicalAuthority = async (filePath: string) => {
      const current = await readWorkspaceDocumentCatalogue(connection!, workspace, { paths: [filePath] });
      const expected = registered.get(filePath);
      if (current.some((entry) => entry.path !== filePath || entry.authority !== 'pristine')
        || nativeLinkJsonProof(current[0] ?? null) !== nativeLinkJsonProof(expected ?? null)) fail('physical-authority-changed', filePath);
    };
    const realRoot = await fs.realpath(workspace.rootPath); const rootStat = await fs.stat(realRoot);
    if (!rootStat.isDirectory()) fail('invalid-workspace-root', '');
    const entries = new Map<string, WorkspaceOriginalPathObservation>();
    const root: WorkspaceOriginalRootObservation = { resolvedRootPath: realRoot, identity: filesystemFileVersion(rootStat), entries };
    const pending = [{ relativePath: '', depth: 0 }];
    while (pending.length) {
      const directory = pending.pop()!;
      const children = (await fs.readdir(path.join(realRoot, directory.relativePath), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const relativePath = directory.relativePath ? `${directory.relativePath}/${child.name}` : child.name;
        if (!isCanonicalAdmissionPath(relativePath)) { gap('invalid-source-path', relativePath); continue; }
        if (child.isDirectory() && (EXCLUDED_DIRECTORIES.has(child.name) || directory.depth === 0 && child.name === '.canvas-skill-drafts')
          || EXCLUDED_FILES.has(child.name) || isInternalWorkspaceStagingPath(child.name)) { excludedPaths.push(relativePath); continue; }
        if (observed.length >= limits.maxPaths) fail('path-count-limit', relativePath);
        await assertWorkspacePathHasNoAliases(workspace, relativePath, { readOnly: true });
        const stat = await fs.lstat(path.join(realRoot, relativePath));
        if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) { gap('unsafe-physical-source', relativePath); continue; }
        const item = { relativePath, stat, identity: filesystemFileVersion(stat) }; observed.push(item); entries.set(relativePath, item);
        namespace.set(relativePath, { workspaceId: workspace.workspaceId, path: relativePath, kind: stat.isDirectory() ? 'directory' : 'file',
          identity: item.identity, filesystemIdentity: item.identity, documentId: null, lifecycleGeneration: null });
        if (stat.isDirectory()) {
          if (directory.depth + 1 > limits.maxDepth) fail('source-depth-limit', relativePath);
          pending.push({ relativePath, depth: directory.depth + 1 });
        }
      }
    }
    for (const document of catalogue) {
      const projection = namespace.get(document.path);
      if (projection?.kind === 'directory') { gap('identity-conflict', document.path); continue; }
      namespace.set(document.path, { workspaceId: workspace.workspaceId, path: document.path, kind: 'file',
        identity: `registry:${document.id}:${document.lifecycle_generation ?? document.yjs_state_lifecycle}`,
        documentId: document.id, lifecycleGeneration: document.lifecycle_generation, filesystemIdentity: projection?.filesystemIdentity ?? null });
      if (document.authority === 'missing-state') { gap('missing-native-state', document.path); continue; }
      if (document.authority !== 'initialized') continue;
      // Extension/capability never authorize projection bytes for this branch.
      try {
        const state = await (dependencies.loadState ?? loadCollaborationStateOnConnection)(connection, document.id, true);
        if (!state || state.documentId !== document.id || state.workspaceId !== workspace.workspaceId || state.organizationId !== (workspace.organizationId ?? null)
          || state.path !== document.path || state.lifecycleGeneration !== document.lifecycle_generation) throw new PhysicalStageConflict('native-identity-conflict', document.path);
        totalBytes += state.yjsState.length;
        if (state.yjsState.length > limits.maxSourceBytes || totalBytes > limits.maxTotalSourceBytes) fail('source-byte-limit', document.path);
        const inventory = inspectPersistedDocumentLinks(state); totalLinks += inventory.links.length;
        if (totalLinks > limits.maxLinks) fail('source-link-limit', document.path);
        sources.push({ kind: 'native', inventory }); gaps.push(...inventory.coverage.gaps.map((entry) => ({ code: entry.code, path: entry.path })));
      } catch (error) {
        if (error instanceof PhysicalStageConflict) gap(error.code, error.filePath); else gap('unreadable-native-source', document.path);
      }
    }
    // A registry-only document proves its namespace ancestors, not physical
    // directories. Preserve actual directory fingerprints where present and
    // never give an implied directory a filesystem or document identity.
    for (const document of catalogue) {
      let parentPath = path.posix.dirname(document.path);
      while (parentPath !== '.' && parentPath !== '/') {
        const prior = namespace.get(parentPath);
        if (prior?.kind === 'file') fail('identity-conflict', document.path);
        if (!prior) {
          if (namespace.size >= limits.maxPaths) fail('source-namespace-limit', parentPath);
          namespace.set(parentPath, { workspaceId: workspace.workspaceId, path: parentPath, kind: 'directory',
            identity: `registry-directory:${nativeLinkJsonProof({ workspaceId: workspace.workspaceId, path: parentPath })}`,
            documentId: null, lifecycleGeneration: null, filesystemIdentity: null });
        }
        parentPath = path.posix.dirname(parentPath);
      }
    }
    for (const entry of namespace.values()) {
      if (namespace.size > limits.maxPaths || entry.path.split('/').length - 1 > limits.maxDepth) fail('source-namespace-limit', entry.path);
      let parentPath = path.posix.dirname(entry.path);
      while (parentPath !== '.' && parentPath !== '/') {
        if (namespace.get(parentPath)?.kind === 'file') fail('identity-conflict', entry.path);
        parentPath = path.posix.dirname(parentPath);
      }
    }
    for (const item of observed) {
      if (!item.stat.isFile()) continue;
      const document = registered.get(item.relativePath);
      if (document && document.authority !== 'pristine') continue;
      if (!/\.(?:md|markdown|html?)$/iu.test(item.relativePath)) {
        if (/\.mdx$/iu.test(item.relativePath)) gap('unsupported-mdx-source', item.relativePath);
        continue;
      }
      try {
        const bytes = await readWorkspaceOriginalFileSource({ configuredRootPath: workspace.rootPath, root, observed: item,
          maxBytes: Math.min(limits.maxSourceBytes, limits.maxTotalSourceBytes - totalBytes),
          verifyCurrentSource: () => verifyPhysicalAuthority(item.relativePath), afterSourceFingerprint: dependencies.afterSourceFingerprint });
        totalBytes += bytes.length;
        const authority = document ? { kind: 'registered-never-initialized' as const, catalogueProof,
          registeredDocumentId: document.id, lineageId: document.lineage_id } : { kind: 'unregistered' as const, catalogueProof };
        const inventory = inspectOriginalPhysicalLinks({ workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null,
          path: item.relativePath, authority, bytes, filesystemIdentity: item.identity, maxLinks: limits.maxLinks - totalLinks });
        totalLinks += inventory.links.length;
        if (totalLinks > limits.maxLinks) fail('source-link-limit', item.relativePath);
        sources.push({ kind: 'physical', inventory }); gaps.push(...inventory.coverage.gaps);
      } catch (error) { if (error instanceof PhysicalStageConflict || error instanceof WorkspaceOriginalFileSourceError) gap(error.code, error.filePath); else gap('unreadable-physical-source', item.relativePath); }
    }
    for (const document of catalogue) if (document.authority === 'pristine' && /\.(?:md|markdown|html?|mdx)$/iu.test(document.path) && !namespace.get(document.path)?.filesystemIdentity) gap('missing-physical-source', document.path);
    // READ COMMITTED gives a fresh catalogue while the SAME shared admission
    // fence remains held. Never release it between classification and FS reads.
    if (nativeLinkJsonProof(await readWorkspaceDocumentCatalogue(connection, workspace)) !== catalogueProof) fail('source-authority-changed', '');
    for (const source of sources) if (source.kind === 'native') {
      const current = await (dependencies.loadState ?? loadCollaborationStateOnConnection)(connection, source.inventory.document.documentId, true);
      if (!current || current.yjsState.length > limits.maxSourceBytes
        || nativeLinkJsonProof(inspectPersistedDocumentLinks(current)) !== nativeLinkJsonProof(source.inventory)) fail('native-source-changed', source.inventory.document.path);
    }
    for (const item of observed) await assertWorkspaceOriginalPathCurrent({ configuredRootPath: workspace.rootPath, root, observed: item });
    if (filesystemFileVersion(await fs.stat(realRoot)) !== root.identity || await fs.realpath(workspace.rootPath) !== realRoot) fail('physical-scope-changed', '');
    await connection.run('COMMIT'); transaction = false;
  } catch (error) {
    if (error instanceof PhysicalStageConflict || error instanceof WorkspaceOriginalFileSourceError) gap(error.code, error.filePath); else gap('source-authority-unavailable', '');
    // Incoherent global authority/namespace observations cannot certify bytes.
    sources.length = 0;
  } finally {
    if (transaction) try { await connection?.run('ROLLBACK'); } catch { discard = new Error('Discarding unresolved source authority stage.'); }
    try { await connection?.close(discard); } catch { gap('source-authority-unavailable', ''); sources.length = 0; }
  }
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId ?? null, catalogueProof,
    namespace: [...namespace.values()].sort((a, b) => a.path.localeCompare(b.path)), sources,
    scope: { kind: 'visible-workspace', excludedPaths: excludedPaths.sort() },
    coverage: { complete: !gaps.length, gaps }, readiness: gaps.length ? 'blocked'
      : sources.some((source) => source.kind === 'physical') ? 'requires-import-and-rebinding' : 'native-coordinator-required', executionReady: false };
  return { ...body, stageProof: workspaceSourceAuthorityStageProof(body) };
}
