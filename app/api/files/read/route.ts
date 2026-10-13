import { NextRequest, NextResponse } from 'next/server';
import { readFile, getFileStats } from '@/app/lib/filesystem/workspace-files';
import { sha256Buffer } from '@/app/lib/files/revision-guard';
import {
  readFileCollaborationState,
  isDocxPath,
} from '@/app/lib/files/collaboration-policy';
import { readOfficeDocumentSnapshot } from '@/app/lib/office/document-service';
import { assessDocxEditorCompatibility } from '@/app/lib/office/editor-compatibility';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { collaborationCheckpointValidationFailure } from '@/app/lib/collaboration/checkpoint-errors';
import { withNativeWorkspaceFileRead } from '@/app/lib/collaboration/workspace-native-file-read';
import type { FileReadStats } from '@/app/lib/files/types';

const READ_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB
const EXCALIDRAW_READ_SIZE_LIMIT = 25 * 1024 * 1024; // embedded image data can make scenes larger

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const limited = rateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'files-read',
    });
    if (!limited.ok) {
      return limited.response;
    }
    
    const { searchParams } = new URL(request.url);
    const path = searchParams.get('path');

    if (!path) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }
    
    if (isDocxPath(path)) {
      const snapshot = await readOfficeDocumentSnapshot(workspaceResult.workspace, path);
      const metaOnly = searchParams.get('meta') === '1';
      const editorCompatibility = metaOnly ? undefined : await assessDocxEditorCompatibility(snapshot.content);
      return NextResponse.json({ success: true, data: {
        ...snapshot, editorCompatibility, viewerUserId: workspaceResult.session.user.id,
        workspaceId: workspaceResult.workspace.workspaceId,
        content: metaOnly ? '' : `base64:${snapshot.content.toString('base64')}`,
      } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const sizeLimit = isExcalidrawFilePath(path) ? EXCALIDRAW_READ_SIZE_LIMIT : READ_SIZE_LIMIT;
    const metaOnly = searchParams.get('meta') === '1';
    const collaborationBootstrap = searchParams.get('collaborationBootstrap') === '1';
    return await withNativeWorkspaceFileRead({ workspace: workspaceResult.workspace, path,
      mode: metaOnly || collaborationBootstrap ? 'metadata' : 'export', maxBytes: sizeLimit }, async native => {
      const collaboration = await readFileCollaborationState({ workspace: workspaceResult.workspace, path });
      if (native) {
        if (collaboration.document?.id !== native.documentId || collaboration.document.provider !== 'yjs') {
          throw Object.assign(new Error('The native document changed before its response.'), { status: 409 });
        }
        const sha256 = native.content ? sha256Buffer(native.content) : null;
        const modified = native.modifiedAt !== null && Number.isFinite(new Date(native.modifiedAt).getTime())
          ? Math.floor(native.modifiedAt / 1000) : undefined;
        return NextResponse.json({ success: true, data: {
          path, content: native.content?.toString('utf8') ?? '', contentUnavailable: native.contentUnavailable,
          stats: { ...(native.content ? { size: native.content.length } : {}),
            ...(modified === undefined ? {} : { modified }),
            ...(sha256 ? { sha256 } : {}) } satisfies FileReadStats,
          revision: sha256 && collaboration.latestRevision?.contentHash === sha256 ? collaboration.latestRevision : null,
          collaboration,
          nativeSource: { documentId: native.documentId, lifecycleGeneration: native.lifecycleGeneration,
            documentSequence: native.documentSequence, source: native.source },
        } }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const stats = await getFileStats(path, fileOptions);
      if (metaOnly) {
        return NextResponse.json({ success: true, data: {
          path, content: '',
          stats: { size: stats.size, modified: stats.modified, permissions: stats.permissions, fileVersion: stats.fileVersion },
          collaboration,
        } }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (stats.size > sizeLimit) {
        return NextResponse.json(
          { success: false, error: 'File is too large to read' },
          { status: 413 }
        );
      }
      const content = await readFile(path, fileOptions);
      if (content.byteLength > sizeLimit) {
        return NextResponse.json({ success: false, error: 'File is too large to read' }, { status: 413 });
      }
      const sha256 = sha256Buffer(content);
      const revision = collaboration.latestRevision?.contentHash === sha256 ? collaboration.latestRevision : null;
      return NextResponse.json({ success: true, data: {
        path, content: content.toString('utf8'),
        stats: { size: content.byteLength, modified: stats.modified, permissions: stats.permissions, sha256, fileVersion: stats.fileVersion },
        revision, collaboration,
      } }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    const validationFailure = collaborationCheckpointValidationFailure(error);
    if (validationFailure) {
      return NextResponse.json({ success: false, error: validationFailure.message,
        code: validationFailure.code, validationCode: validationFailure.validationCode }, { status: validationFailure.status });
    }
    // If the error is ENOENT (file not found), return a 404 status
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    console.error('[API] File read error:', error);
    
    const message = error instanceof Error ? error.message : 'Failed to read file';
    return NextResponse.json(
      { success: false, error: message },
      { status: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500 }
    );
  }
}
