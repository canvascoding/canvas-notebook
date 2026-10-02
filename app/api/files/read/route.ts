import { NextRequest, NextResponse } from 'next/server';
import { readFile, getFileStats } from '@/app/lib/filesystem/workspace-files';
import { sha256Buffer } from '@/app/lib/files/revision-guard';
import {
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
  isDocxPath,
} from '@/app/lib/files/collaboration-policy';
import { readOfficeDocumentSnapshot } from '@/app/lib/office/document-service';
import { assessDocxEditorCompatibility } from '@/app/lib/office/editor-compatibility';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { collaborativeReadSnapshot } from '@/app/lib/files/collaborative-read-snapshot';
import { collaborationCheckpointValidationFailure } from '@/app/lib/collaboration/checkpoint-errors';

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
    const stats = await getFileStats(path, fileOptions);
    const sizeLimit = isExcalidrawFilePath(path) ? EXCALIDRAW_READ_SIZE_LIMIT : READ_SIZE_LIMIT;
    const metaOnly = searchParams.get('meta') === '1';

    if (metaOnly) {
      const collaboration = await getFileCollaborationState({
        workspace: workspaceResult.workspace,
        path,
      });
      return NextResponse.json({
        success: true,
        data: {
          path: path,
          content: '',
          stats: {
            size: stats.size,
            modified: stats.modified,
            permissions: stats.permissions,
            fileVersion: stats.fileVersion,
          },
          collaboration,
        },
      });
    }
    
    if (stats.size > sizeLimit) {
        return NextResponse.json(
            { success: false, error: 'File is too large to read' },
            { status: 413 }
        );
    }

    let collaboration = await getFileCollaborationState({
      workspace: workspaceResult.workspace,
      path,
      ensureDocument: true,
    });
    const liveDocument = collaboration.document?.provider === 'yjs' && collaboration.document.status === 'active'
      ? collaboration.document : null;
    const liveState = liveDocument ? await loadCollaborationState(liveDocument.id) : null;
    const collaborationBootstrap = searchParams.get('collaborationBootstrap') === '1';
    const durableContent = liveDocument ? collaborativeReadSnapshot({
      workspace: workspaceResult.workspace, collaboration,
      state: liveState, allowQuarantinedMetadata: collaborationBootstrap,
      allowUnprojectableMetadata: collaborationBootstrap,
    }) : null;
    if (collaborationBootstrap && liveState && durableContent === null) {
      return NextResponse.json({ success: true, data: {
        path, content: '', contentUnavailable: true,
        stats: { size: stats.size, modified: stats.modified, permissions: stats.permissions, fileVersion: stats.fileVersion },
        revision: null, collaboration,
      } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const content = durableContent ?? await readFile(path, fileOptions);
    if (content.byteLength > sizeLimit) {
      return NextResponse.json({ success: false, error: 'File is too large to read' }, { status: 413 });
    }
    const sha256 = sha256Buffer(content);
    // A read does not capture history for a Yjs-owned document: its durable
    // mutation/checkpoint owns that. Otherwise a delayed disk projection can
    // append old -> new -> old revisions merely by opening the file.
    const revision = liveDocument
      ? collaboration.latestRevision?.contentHash === sha256 ? collaboration.latestRevision : null
      : await ensureFileRevisionForCurrentContent({
      workspace: workspaceResult.workspace,
      path,
      contentHash: sha256,
      sizeBytes: content.byteLength,
      actorUserId: workspaceResult.session.user.id,
      actorType: 'user',
      sourceSessionId: null,
    });
    if (!liveDocument) collaboration = await getFileCollaborationState({
      workspace: workspaceResult.workspace,
      path,
      ensureDocument: true,
    });
    
    return NextResponse.json({
      success: true,
      data: {
        path: path,
        content: content.toString('utf-8'),
        stats: {
          size: content.byteLength,
          modified: stats.modified,
          permissions: stats.permissions,
          sha256,
          fileVersion: stats.fileVersion,
        },
        revision,
        collaboration,
      },
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
