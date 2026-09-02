import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
} from '@/app/lib/files/collaboration-policy';
import { writeWorkspaceFileContent } from '@/app/lib/files/write-service';
import { getWorkspaceFileRevision } from '@/app/lib/files/revision-guard';
import {
  readFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import { importPortableExcalidrawAssets } from '@/app/lib/excalidraw-collaboration/assets';
import {
  materializeExcalidrawCheckpoint,
  serializePortableExcalidrawScene,
} from '@/app/lib/excalidraw-collaboration/checkpoint';
import {
  applyExcalidrawScenePatch,
  ensureExcalidrawScene,
  loadExcalidrawScene,
  type PersistedExcalidrawScene,
} from '@/app/lib/excalidraw-collaboration/repository';
import {
  sharedExcalidrawAppState,
  validateExcalidrawElements,
} from '@/app/lib/excalidraw-collaboration/scene';
import type { ExcalidrawAssetMetadata } from '@/app/lib/excalidraw-collaboration/protocol';
import { EXCALIDRAW_FILE_SOURCE } from '@/app/lib/excalidraw-file';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import { normalizeMobileFilePath } from './files';

const MAX_MOBILE_EXCALIDRAW_BYTES = 10 * 1024 * 1024;

type PortableExcalidrawScene = {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

export type MobileExcalidrawDocument = {
  path: string;
  name: string;
  content: string;
  sha256: string;
  revisionId: string;
  sceneSequence: number | null;
  canEdit: boolean;
  editBlockReason: 'READ_ONLY' | 'COLLABORATION_DEGRADED' | null;
  collaborationActive: boolean;
};

export class MobileExcalidrawError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly currentSceneSequence: number | null = null,
  ) {
    super(message);
    this.name = 'MobileExcalidrawError';
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeExcalidrawPath(value: unknown): string {
  const filePath = normalizeMobileFilePath(value, false);
  if (path.posix.extname(filePath).toLowerCase() !== '.excalidraw') {
    throw new MobileExcalidrawError(
      'The selected file is not an Excalidraw document.',
      400,
      'INVALID_EXCALIDRAW_PATH',
    );
  }
  return filePath;
}

function parsePortableScene(content: unknown): PortableExcalidrawScene {
  if (typeof content !== 'string') {
    throw new MobileExcalidrawError('Excalidraw content is required.', 400, 'INVALID_CONTENT');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_MOBILE_EXCALIDRAW_BYTES) {
    throw new MobileExcalidrawError(
      'Mobile Excalidraw documents may be at most 10 MiB.',
      413,
      'DOCUMENT_TOO_LARGE',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MobileExcalidrawError('The Excalidraw document is not valid JSON.', 422, 'INVALID_EXCALIDRAW');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MobileExcalidrawError('The Excalidraw document has an invalid root object.', 422, 'INVALID_EXCALIDRAW');
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'excalidraw' || !Array.isArray(record.elements)) {
    throw new MobileExcalidrawError('The Excalidraw document has an invalid scene.', 422, 'INVALID_EXCALIDRAW');
  }
  if (record.appState !== undefined && (!record.appState || typeof record.appState !== 'object' || Array.isArray(record.appState))) {
    throw new MobileExcalidrawError('The Excalidraw app state is invalid.', 422, 'INVALID_EXCALIDRAW');
  }
  if (record.files !== undefined && (!record.files || typeof record.files !== 'object' || Array.isArray(record.files))) {
    throw new MobileExcalidrawError('The Excalidraw files map is invalid.', 422, 'INVALID_EXCALIDRAW');
  }
  return {
    elements: record.elements as Record<string, unknown>[],
    appState: (record.appState as Record<string, unknown> | undefined) ?? {},
    files: (record.files as Record<string, unknown> | undefined) ?? {},
  };
}

async function readPhysicalExcalidraw(
  filePath: string,
  fileOptions: WorkspaceFileOperationOptions,
): Promise<{ content: string; sha256: string; size: number; modified: number }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath, fileOptions);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new MobileExcalidrawError('Excalidraw file was not found.', 404, 'FILE_NOT_FOUND');
    }
    throw error;
  }
  if (buffer.byteLength > MAX_MOBILE_EXCALIDRAW_BYTES) {
    throw new MobileExcalidrawError(
      'Mobile Excalidraw documents may be at most 10 MiB.',
      413,
      'DOCUMENT_TOO_LARGE',
    );
  }
  const revision = await getWorkspaceFileRevision(filePath, fileOptions);
  if (!revision) throw new MobileExcalidrawError('Excalidraw file was not found.', 404, 'FILE_NOT_FOUND');
  const content = buffer.toString('utf8');
  parsePortableScene(content);
  return {
    content,
    sha256: revision.sha256,
    size: revision.stats.size,
    modified: revision.stats.modified,
  };
}

async function ensureSharedScene(input: {
  workspace: WorkspaceContext;
  documentId: string;
  path: string;
  initialContent: string;
}): Promise<PersistedExcalidrawScene> {
  const existing = await loadExcalidrawScene(input.documentId);
  if (existing) {
    if (existing.workspaceId !== input.workspace.workspaceId) {
      throw new MobileExcalidrawError(
        'The Excalidraw collaboration scene belongs to a different workspace.',
        409,
        'EXCALIDRAW_SCENE_CONFLICT',
        existing.sceneSequence,
      );
    }
    return existing;
  }
  const initialAssets = await importPortableExcalidrawAssets({
    workspaceId: input.workspace.workspaceId,
    content: input.initialContent,
  });
  return ensureExcalidrawScene({
    documentId: input.documentId,
    workspaceId: input.workspace.workspaceId,
    organizationId: input.workspace.organizationId ?? null,
    path: input.path,
    initialContent: input.initialContent,
    initialAssets,
  });
}

async function documentValue(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  path: string;
}): Promise<MobileExcalidrawDocument> {
  const physical = await readPhysicalExcalidraw(input.path, input.fileOptions);
  const revision = await ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: input.path,
    contentHash: physical.sha256,
    sizeBytes: physical.size,
    actorType: 'system',
  });
  const collaboration = await getFileCollaborationState({
    workspace: input.workspace,
    path: input.path,
    ensureDocument: false,
  });
  let content = physical.content;
  let scene: PersistedExcalidrawScene | null = null;
  if (collaboration.sceneCapable && collaboration.document) {
    scene = await ensureSharedScene({
      workspace: input.workspace,
      documentId: collaboration.document.id,
      path: input.path,
      initialContent: physical.content,
    });
    content = await serializePortableExcalidrawScene(scene);
  }
  const degraded = Boolean(scene?.degradedReason);
  const canEdit = input.workspace.permissions.canWrite && !degraded;
  return {
    path: input.path,
    name: path.posix.basename(input.path),
    content,
    sha256: sha256(content),
    revisionId: scene?.checkpointRevisionId ?? revision.id,
    sceneSequence: scene?.sceneSequence ?? null,
    canEdit,
    editBlockReason: !input.workspace.permissions.canWrite
      ? 'READ_ONLY'
      : degraded
        ? 'COLLABORATION_DEGRADED'
        : null,
    collaborationActive: Boolean(scene),
  };
}

export async function readMobileExcalidrawDocument(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  path: unknown;
}): Promise<MobileExcalidrawDocument> {
  return documentValue({
    workspace: input.workspace,
    fileOptions: input.fileOptions,
    path: normalizeExcalidrawPath(input.path),
  });
}

function deletionTombstones(
  current: PersistedExcalidrawScene['elements'],
  incoming: PortableExcalidrawScene['elements'],
): PersistedExcalidrawScene['elements'] {
  const incomingIds = new Set(incoming.map((element) => element.id).filter((id): id is string => typeof id === 'string'));
  return current
    .filter((element) => !element.isDeleted && !incomingIds.has(element.id))
    .map((element) => ({
      ...element,
      isDeleted: true,
      version: element.version + 1,
      versionNonce: element.versionNonce < Number.MAX_SAFE_INTEGER ? element.versionNonce + 1 : 0,
      updated: Date.now(),
    }));
}

async function sceneAssets(input: {
  workspaceId: string;
  content: string;
  files: PortableExcalidrawScene['files'];
  current: ExcalidrawAssetMetadata[];
}): Promise<ExcalidrawAssetMetadata[]> {
  const imported = await importPortableExcalidrawAssets({
    workspaceId: input.workspaceId,
    content: input.content,
  });
  const available = new Map([...input.current, ...imported].map((asset) => [asset.fileId, asset]));
  return Object.keys(input.files).map((fileId) => {
    const asset = available.get(fileId);
    if (!asset) {
      throw new MobileExcalidrawError(
        `Excalidraw image data is missing: ${fileId}.`,
        422,
        'EXCALIDRAW_ASSET_MISSING',
      );
    }
    return asset;
  });
}

async function saveSharedScene(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  actorSessionId: string;
  path: string;
  content: string;
  parsed: PortableExcalidrawScene;
  baseSceneSequence: unknown;
  documentId: string;
}): Promise<MobileExcalidrawDocument> {
  const physical = await readPhysicalExcalidraw(input.path, input.fileOptions);
  const current = await ensureSharedScene({
    workspace: input.workspace,
    documentId: input.documentId,
    path: input.path,
    initialContent: physical.content,
  });
  if (!Number.isSafeInteger(input.baseSceneSequence) || Number(input.baseSceneSequence) < 0) {
    throw new MobileExcalidrawError(
      'A current Excalidraw scene sequence is required.',
      428,
      'FILE_REVISION_REQUIRED',
      current.sceneSequence,
    );
  }
  if (Number(input.baseSceneSequence) !== current.sceneSequence) {
    throw new MobileExcalidrawError(
      'Excalidraw scene conflict: this drawing changed after it was loaded.',
      409,
      'EXCALIDRAW_SCENE_CONFLICT',
      current.sceneSequence,
    );
  }
  const elements = validateExcalidrawElements(input.parsed.elements, 'scene');
  const assets = await sceneAssets({
    workspaceId: input.workspace.workspaceId,
    content: input.content,
    files: input.parsed.files,
    current: current.assets,
  });
  const applied = await applyExcalidrawScenePatch({
    documentId: input.documentId,
    lifecycleGeneration: current.lifecycleGeneration,
    baseSequence: current.sceneSequence,
    messageId: `mobile-excalidraw-${randomUUID()}`,
    elements: [...elements, ...deletionTombstones(current.elements, elements)],
    appState: sharedExcalidrawAppState(input.parsed.appState),
    assets,
    actorType: 'user',
    actorId: input.actorUserId,
    initiatedByUserId: input.actorUserId,
  });
  await materializeExcalidrawCheckpoint({
    state: applied.state,
    workspace: input.workspace,
    actorUserId: input.actorUserId,
    actorType: 'user',
    sourceSessionId: input.actorSessionId,
  });
  return documentValue(input);
}

export async function saveMobileExcalidrawDocument(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  actorSessionId: string;
  path: unknown;
  content: unknown;
  expectedSha256: unknown;
  baseRevisionId: unknown;
  baseSceneSequence: unknown;
}): Promise<MobileExcalidrawDocument> {
  const filePath = normalizeExcalidrawPath(input.path);
  const parsed = parsePortableScene(input.content);
  const content = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: EXCALIDRAW_FILE_SOURCE,
    elements: parsed.elements,
    appState: parsed.appState,
    files: parsed.files,
  }, null, 2);
  const collaboration = await getFileCollaborationState({
    workspace: input.workspace,
    path: filePath,
    ensureDocument: false,
  });
  if (collaboration.sceneCapable && collaboration.document) {
    return saveSharedScene({
      ...input,
      path: filePath,
      content,
      parsed,
      documentId: collaboration.document.id,
    });
  }
  if (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new MobileExcalidrawError('A current document hash is required.', 428, 'FILE_REVISION_REQUIRED');
  }
  if (typeof input.baseRevisionId !== 'string' || !input.baseRevisionId.trim()) {
    throw new MobileExcalidrawError('A current document revision is required.', 428, 'FILE_REVISION_REQUIRED');
  }
  await writeWorkspaceFileContent({
    workspace: input.workspace,
    fileOptions: input.fileOptions,
    actorUserId: input.actorUserId,
    actorSessionId: input.actorSessionId,
    path: filePath,
    content,
    expectedSha256: input.expectedSha256,
    requireExpectedRevision: true,
    baseRevisionId: input.baseRevisionId.trim(),
    ensureCollaborationDocument: false,
  });
  return documentValue({ ...input, path: filePath });
}
