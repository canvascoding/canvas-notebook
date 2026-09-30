import 'server-only';

import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import {
  computeWorkspaceFileOperationPlanId,
  type WorkspaceFileOperationPreview,
} from '@/app/lib/markdown/workspace-file-operation-planner';
import { groupWorkspaceLinkWrites } from '@/app/lib/markdown/workspace-link-write-groups';
import { isWorkspaceFileOperationLinkSafe } from '@/app/lib/markdown/workspace-file-operation-link-safety';
import type { WorkspaceLinkWritePreflight } from '@/app/lib/markdown/workspace-link-write-executor';
import { WorkspaceOperationJournal, type WorkspaceOperationRecord } from './workspace-operation-journal';

const DOCUMENT_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const MANIFEST_LIMIT = 8 * 1024 * 1024;
const DOCUMENT_COUNT_LIMIT = 256;
const DIRECTORY_NAME = 'workspace-operation-staging';

export type WorkspaceOperationOriginalDocument = { workspaceId: string; path: string; content: string };
export type WorkspaceOperationStageIdentity = {
  operationId: string;
  planId: string;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
};
export type WorkspaceOperationStageInput = Omit<WorkspaceOperationStageIdentity, 'planId'> & {
  preview: WorkspaceFileOperationPreview;
  originalDocuments: ReadonlyArray<WorkspaceOperationOriginalDocument>;
  /** Authoritative document identities read before any path mutation. */
  linkPreflight?: WorkspaceLinkWritePreflight | null;
};
type DocumentDescriptor = {
  file: string;
  role: 'before' | 'after';
  workspaceId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
};
type StoredPreview = Omit<WorkspaceFileOperationPreview, 'previewContents'>;
type ManifestPayload = WorkspaceOperationStageIdentity & {
  version: 1;
  preview: StoredPreview;
  documents: DocumentDescriptor[];
  linkPreflight: WorkspaceLinkWritePreflight | null;
};
type Manifest = ManifestPayload & { payloadSha256: string };

export type WorkspaceOperationStage = {
  identity: WorkspaceOperationStageIdentity;
  preview: WorkspaceFileOperationPreview;
  originalDocuments: WorkspaceOperationOriginalDocument[];
  linkPreflight: WorkspaceLinkWritePreflight | null;
  payloadSha256: string;
};

export class WorkspaceOperationStagingError extends Error {
  readonly status = 409;
  constructor(readonly code: 'UNSAFE_STORAGE' | 'CORRUPT_STAGE' | 'STAGE_CONFLICT' | 'STAGE_TOO_LARGE' | 'NOT_COMPLETED', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceOperationStagingError';
  }
}

function fail(code: WorkspaceOperationStagingError['code'], message: string): never {
  throw new WorkspaceOperationStagingError(code, message);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertIdentity(identity: WorkspaceOperationStageIdentity): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(identity.operationId)
    || !/^[a-f0-9]{64}$/u.test(identity.planId)
    || !identity.sourceWorkspaceId || !identity.destinationWorkspaceId
    || identity.sourceWorkspaceId.length > 256 || identity.destinationWorkspaceId.length > 256) {
    fail('STAGE_CONFLICT', 'Invalid workspace operation staging identity.');
  }
}

function validPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
    fail('UNSAFE_STORAGE', 'Workspace operation staging requires a private, runtime-owned directory.');
  }
}

async function writePrivateFile(filename: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function readPrivateFile(filename: string, maximum: number): Promise<Buffer> {
  let handle: FileHandle;
  try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (hasCode(error, 'ELOOP')) fail('UNSAFE_STORAGE', 'Workspace operation staging cannot read symbolic links.');
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
      fail('UNSAFE_STORAGE', 'Workspace operation staging requires private, unlinked regular files.');
    }
    if (stat.size > maximum) fail('CORRUPT_STAGE', 'Staged file exceeds its maximum size.');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) fail('CORRUPT_STAGE', 'Staged file changed while being read.');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

function utf8Bytes(content: string): Buffer {
  if (typeof content !== 'string') fail('STAGE_CONFLICT', 'Staged Markdown content must be text.');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > DOCUMENT_LIMIT) fail('STAGE_TOO_LARGE', 'One staged Markdown document exceeds 4 MiB.');
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== content) {
    fail('STAGE_CONFLICT', 'Staged Markdown content is not round-trip UTF-8.');
  }
  return bytes;
}

function decodedUtf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('CORRUPT_STAGE', 'Staged Markdown is not valid UTF-8.'); }
}

function validateCoverage(
  preview: WorkspaceFileOperationPreview,
  originals: ReadonlyArray<WorkspaceOperationOriginalDocument>,
  linkPreflight: WorkspaceLinkWritePreflight | null,
): void {
  if (!preview || !Array.isArray(preview.issues) || !Array.isArray(preview.linkEdits)
    || !Array.isArray(preview.previewContents) || !preview.coverage
    || preview.readiness !== 'ready' || preview.issues.length !== 0 || !isWorkspaceFileOperationLinkSafe(preview)
    || !['rename', 'move', 'copy'].includes(preview.kind)) {
    fail('STAGE_CONFLICT', 'Only link-safe, ready Rename/Move/Copy previews may be staged.');
  }
  if (computeWorkspaceFileOperationPlanId(preview) !== preview.planId) {
    fail('STAGE_CONFLICT', 'Preview body does not match its plan ID.');
  }
  const before = new Map<string, WorkspaceOperationOriginalDocument>();
  const after = new Set<string>();
  for (const document of originals) {
    if (!validPath(document.path) || !document.workspaceId) fail('STAGE_CONFLICT', 'Original Markdown path is invalid.');
    const key = `${document.workspaceId}\0${document.path}`;
    if (before.has(key)) fail('STAGE_CONFLICT', 'Duplicate original Markdown document.');
    utf8Bytes(document.content);
    before.set(key, document);
  }
  for (const document of preview.previewContents) {
    if (!validPath(document.path) || !document.workspaceId) fail('STAGE_CONFLICT', 'Rewritten Markdown path is invalid.');
    const key = `${document.workspaceId}\0${document.path}`;
    if (after.has(key)) fail('STAGE_CONFLICT', 'Duplicate rewritten Markdown document.');
    after.add(key);
    utf8Bytes(document.content);
  }
  const requiredBefore = new Set<string>();
  for (const edit of preview.linkEdits) {
    const beforeKey = `${edit.sourceWorkspaceId}\0${edit.sourcePathBefore}`;
    const afterKey = `${edit.destinationWorkspaceId}\0${edit.sourcePathAfter}`;
    const source = before.get(beforeKey);
    if (!source || digest(utf8Bytes(source.content)) !== edit.expectedContentHash || !after.has(afterKey)) {
      fail('STAGE_CONFLICT', 'Every link edit needs exact original and rewritten Markdown bytes.');
    }
    requiredBefore.add(beforeKey);
  }
  if (requiredBefore.size !== before.size) fail('STAGE_CONFLICT', 'Unrelated original Markdown content cannot be staged.');
  let groups;
  try { groups = groupWorkspaceLinkWrites(preview); }
  catch { return fail('STAGE_CONFLICT', 'Link writes do not form independent Markdown documents.'); }
  if (groups.length > 0 && !linkPreflight) {
    fail('STAGE_CONFLICT', 'Link writes require an authoritative document preflight before path mutation.');
  }
  if (linkPreflight) {
    if (Object.keys(linkPreflight).sort().join(',') !== 'planId,sources'
      || linkPreflight.planId !== preview.planId || !Array.isArray(linkPreflight.sources)
      || linkPreflight.sources.length !== groups.length) {
      fail('STAGE_CONFLICT', 'Document preflight does not match the staged link plan.');
    }
    const sourceFences = new Map<string, WorkspaceLinkWritePreflight['sources'][number]>();
    for (const source of linkPreflight.sources) {
      if (!source || typeof source !== 'object'
        || Object.keys(source).sort().join(',') !== 'beforeSha256,documentId,mode,sourcePathBefore,sourceWorkspaceId'
        || !validPath(source.sourcePathBefore) || !source.sourceWorkspaceId
        || source.sourceWorkspaceId.length > 256
        || !/^[a-f0-9]{64}$/u.test(source.beforeSha256)
        || !((source.mode === 'plain-file' && source.documentId === null)
          || (source.mode === 'active-yjs' && typeof source.documentId === 'string'
            && source.documentId.length >= 1 && source.documentId.length <= 256
            && !/[\x00-\x1f\x7f]/u.test(source.documentId)))) {
        fail('STAGE_CONFLICT', 'Document preflight mode or identity is invalid.');
      }
      const key = `${source.sourceWorkspaceId}\0${source.sourcePathBefore}`;
      if (sourceFences.has(key)) fail('STAGE_CONFLICT', 'Duplicate document preflight source.');
      sourceFences.set(key, source);
    }
    for (const group of groups) {
      const source = sourceFences.get(`${group.sourceWorkspaceId}\0${group.sourcePathBefore}`);
      if (!source || source.beforeSha256 !== group.beforeSha256) {
        fail('STAGE_CONFLICT', 'Document preflight source hash differs from the link plan.');
      }
    }
  }
  for (const group of groups) {
    const source = before.get(`${group.sourceWorkspaceId}\0${group.sourcePathBefore}`);
    if (!source) fail('STAGE_CONFLICT', 'Link write lacks original Markdown.');
    let rewritten = source.content;
    let previousStart = Number.POSITIVE_INFINITY;
    for (const edit of [...group.edits].sort((a, b) => b.targetRange.startUtf16 - a.targetRange.startUtf16)) {
      const range = edit.targetRange;
      if (!Number.isSafeInteger(range.startUtf16) || !Number.isSafeInteger(range.endUtf16)
        || range.startUtf16 < 0 || range.endUtf16 > source.content.length
        || range.endUtf16 <= range.startUtf16 || range.endUtf16 > previousStart
        || range.startUtf8Byte !== Buffer.byteLength(source.content.slice(0, range.startUtf16), 'utf8')
        || range.endUtf8Byte !== Buffer.byteLength(source.content.slice(0, range.endUtf16), 'utf8')
        || source.content.slice(range.startUtf16, range.endUtf16) !== edit.previousTargetLiteral) {
        fail('STAGE_CONFLICT', 'Link edit spans differ from the staged original Markdown.');
      }
      rewritten = `${rewritten.slice(0, range.startUtf16)}${edit.nextTargetLiteral}${rewritten.slice(range.endUtf16)}`;
      previousStart = range.startUtf16;
    }
    if (rewritten !== group.afterContent || digest(rewritten) !== group.afterSha256) {
      fail('STAGE_CONFLICT', 'Rewritten Markdown differs from its planned link edits.');
    }
  }
}

function preparePayload(input: WorkspaceOperationStageInput): { payload: ManifestPayload; bytes: Buffer[] } {
  const identity: WorkspaceOperationStageIdentity = {
    operationId: input.operationId,
    planId: input.preview.planId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    destinationWorkspaceId: input.destinationWorkspaceId,
  };
  assertIdentity(identity);
  const linkPreflight = input.linkPreflight ?? null;
  validateCoverage(input.preview, input.originalDocuments, linkPreflight);
  const { previewContents, ...preview } = input.preview;
  const orderedBefore = [...input.originalDocuments].sort((a, b) =>
    `${a.workspaceId}\0${a.path}` < `${b.workspaceId}\0${b.path}` ? -1 : 1);
  const entries = [
    ...orderedBefore.map((document) => ({ ...document, role: 'before' as const })),
    ...previewContents.map((document) => ({ ...document, role: 'after' as const })),
  ];
  if (entries.length > DOCUMENT_COUNT_LIMIT) fail('STAGE_TOO_LARGE', 'Too many Markdown documents need recovery staging.');
  const bytes = entries.map((entry) => utf8Bytes(entry.content));
  if (bytes.reduce((sum, item) => sum + item.byteLength, 0) > TOTAL_LIMIT) {
    fail('STAGE_TOO_LARGE', 'Recovery staging exceeds the 64 MiB operation limit.');
  }
  const documents = entries.map((entry, index): DocumentDescriptor => ({
    file: `document-${String(index).padStart(6, '0')}.md`,
    role: entry.role,
    workspaceId: entry.workspaceId,
    path: entry.path,
    sizeBytes: bytes[index]!.byteLength,
    sha256: digest(bytes[index]!),
  }));
  const payload: ManifestPayload = { version: 1, ...identity, preview, documents, linkPreflight };
  return { payload, bytes };
}

export class WorkspaceOperationStaging {
  private readonly dataRoot: string;
  private readonly completionLookup: (operationId: string) => Promise<Pick<WorkspaceOperationRecord,
    'operationId' | 'planId' | 'sourceWorkspaceId' | 'destinationWorkspaceId' | 'status'> | null>;

  constructor(options: {
    dataRoot?: string;
    completionLookup?: (operationId: string) => Promise<Pick<WorkspaceOperationRecord,
      'operationId' | 'planId' | 'sourceWorkspaceId' | 'destinationWorkspaceId' | 'status'> | null>;
  } = {}) {
    this.dataRoot = options.dataRoot ?? resolveCanvasDataRoot();
    this.completionLookup = options.completionLookup ?? (async (operationId) => new WorkspaceOperationJournal().get(operationId));
  }

  private async root(): Promise<string> {
    await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    // A configured DATA symlink may be intentional; all descendants are ours.
    const configured = await fs.realpath(this.dataRoot);
    const root = path.join(configured, DIRECTORY_NAME);
    await ensurePrivateDirectory(root);
    await syncDirectory(root);
    await syncDirectory(configured);
    return root;
  }

  async stage(input: WorkspaceOperationStageInput): Promise<WorkspaceOperationStage> {
    const { payload, bytes } = preparePayload(input);
    const payloadSha256 = digest(JSON.stringify(payload));
    const manifest: Manifest = { ...payload, payloadSha256 };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (manifestBytes.byteLength > MANIFEST_LIMIT) fail('STAGE_TOO_LARGE', 'Recovery manifest exceeds 8 MiB.');
    const identity: WorkspaceOperationStageIdentity = payload;
    const root = await this.root();
    const finalPath = path.join(root, input.operationId);
    const existing = await this.loadIfPresent(identity, root);
    if (existing) {
      if (existing.payloadSha256 !== payloadSha256) fail('STAGE_CONFLICT', 'Operation ID is already staged with a different plan.');
      return existing;
    }
    const temporary = path.join(root, `.tmp-${randomUUID()}`);
    await ensurePrivateDirectory(temporary);
    try {
      for (let index = 0; index < payload.documents.length; index += 1) {
        await writePrivateFile(path.join(temporary, payload.documents[index]!.file), bytes[index]!);
      }
      await writePrivateFile(path.join(temporary, 'manifest.json'), manifestBytes);
      await syncDirectory(temporary);
      try { await fs.rename(temporary, finalPath); }
      catch (error) {
        if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error;
        const concurrent = await this.loadIfPresent(identity, root);
        if (!concurrent || concurrent.payloadSha256 !== payloadSha256) {
          fail('STAGE_CONFLICT', 'Concurrent staging published a different operation plan.');
        }
        return concurrent;
      }
      await syncDirectory(root);
      return (await this.loadIfPresent(identity, root))!;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  private async loadIfPresent(identity: WorkspaceOperationStageIdentity, root: string): Promise<WorkspaceOperationStage | null> {
    const directory = path.join(root, identity.operationId);
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
      fail('UNSAFE_STORAGE', 'Staging operation directory is not private and runtime-owned.');
    }
    const manifestBytes = await readPrivateFile(path.join(directory, 'manifest.json'), MANIFEST_LIMIT);
    let manifest: Manifest;
    try { manifest = JSON.parse(decodedUtf8(manifestBytes)) as Manifest; }
    catch { return fail('CORRUPT_STAGE', 'Staged manifest is not valid JSON.'); }
    if (!manifest || manifest.version !== 1 || manifest.operationId !== identity.operationId
      || manifest.planId !== identity.planId || manifest.sourceWorkspaceId !== identity.sourceWorkspaceId
      || manifest.destinationWorkspaceId !== identity.destinationWorkspaceId
      || !Array.isArray(manifest.documents) || manifest.documents.length > DOCUMENT_COUNT_LIMIT
      || !manifest.preview || manifest.preview.planId !== identity.planId
      || (manifest.linkPreflight !== null && (!manifest.linkPreflight || typeof manifest.linkPreflight !== 'object'))
      || !/^[a-f0-9]{64}$/u.test(manifest.payloadSha256)) {
      fail('CORRUPT_STAGE', 'Staged manifest identity or structure is invalid.');
    }
    const { payloadSha256, ...payload } = manifest;
    if (digest(JSON.stringify(payload)) !== payloadSha256) fail('CORRUPT_STAGE', 'Staged manifest hash differs.');
    let total = 0;
    const originals: WorkspaceOperationOriginalDocument[] = [];
    const rewritten: WorkspaceFileOperationPreview['previewContents'] = [];
    for (let index = 0; index < manifest.documents.length; index += 1) {
      const descriptor = manifest.documents[index]!;
      if (!descriptor || typeof descriptor !== 'object'
        || descriptor.file !== `document-${String(index).padStart(6, '0')}.md`
        || !['before', 'after'].includes(descriptor.role) || !validPath(descriptor.path)
        || !descriptor.workspaceId || !Number.isSafeInteger(descriptor.sizeBytes)
        || descriptor.sizeBytes < 0 || descriptor.sizeBytes > DOCUMENT_LIMIT
        || !/^[a-f0-9]{64}$/u.test(descriptor.sha256)) {
        fail('CORRUPT_STAGE', 'Staged document descriptor is invalid.');
      }
      total += descriptor.sizeBytes;
      if (total > TOTAL_LIMIT) fail('CORRUPT_STAGE', 'Staged Markdown exceeds the operation limit.');
      const documentBytes = await readPrivateFile(path.join(directory, descriptor.file), DOCUMENT_LIMIT);
      if (documentBytes.byteLength !== descriptor.sizeBytes || digest(documentBytes) !== descriptor.sha256) {
        fail('CORRUPT_STAGE', 'Staged Markdown content hash differs.');
      }
      const document = { workspaceId: descriptor.workspaceId, path: descriptor.path, content: decodedUtf8(documentBytes) };
      if (descriptor.role === 'before') originals.push(document);
      else rewritten.push(document);
    }
    const preview = { ...manifest.preview, previewContents: rewritten } as WorkspaceFileOperationPreview;
    try { validateCoverage(preview, originals, manifest.linkPreflight); }
    catch (error) {
      if (error instanceof WorkspaceOperationStagingError) {
        fail('CORRUPT_STAGE', 'Staged plan no longer matches its original and rewritten Markdown.');
      }
      throw error;
    }
    return { identity, preview, originalDocuments: originals, linkPreflight: manifest.linkPreflight, payloadSha256 };
  }

  async load(identity: WorkspaceOperationStageIdentity): Promise<WorkspaceOperationStage> {
    assertIdentity(identity);
    const result = await this.loadIfPresent(identity, await this.root());
    if (!result) fail('CORRUPT_STAGE', 'Recovery stage is missing.');
    return result;
  }

  async removeCompleted(identity: WorkspaceOperationStageIdentity): Promise<void> {
    assertIdentity(identity);
    const operation = await this.completionLookup(identity.operationId);
    if (!operation || operation.status !== 'completed' || operation.planId !== identity.planId
      || operation.sourceWorkspaceId !== identity.sourceWorkspaceId
      || operation.destinationWorkspaceId !== identity.destinationWorkspaceId) {
      fail('NOT_COMPLETED', 'Recovery stage can only be deleted after durable operation completion.');
    }
    const root = await this.root();
    const retiringPrefix = `.completed-${identity.operationId}-`;
    for (const name of await fs.readdir(root)) {
      if (!name.startsWith(retiringPrefix)) continue;
      const suffix = name.slice(retiringPrefix.length);
      if (!/^[a-f0-9-]{36}$/u.test(suffix)) continue;
      const retired = path.join(root, name);
      let stat;
      try { stat = await fs.lstat(retired); }
      catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
        fail('UNSAFE_STORAGE', 'Retired staging operation is not a private directory.');
      }
      await fs.rm(retired, { recursive: true, force: true });
    }
    const staged = await this.loadIfPresent(identity, root);
    if (!staged) { await syncDirectory(root); return; }
    const directory = path.join(root, identity.operationId);
    const retiring = path.join(root, `.completed-${identity.operationId}-${randomUUID()}`);
    // The durable completed receipt has been checked above. Rename hides the
    // complete stage atomically, so a crash during cleanup never exposes a
    // half-deleted recovery bundle under the operation ID.
    try { await fs.rename(directory, retiring); }
    catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
    await syncDirectory(root);
    await fs.rm(retiring, { recursive: true, force: true });
    await syncDirectory(root);
  }
}
