import { NextRequest, NextResponse } from 'next/server';

import { readFile } from '@/app/lib/filesystem/workspace-files';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { workspaceRequiresCollaborationPolicy } from '@/app/lib/files/collaboration-policy';
import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { ensureCollaborationState, loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { issueCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import { importPortableExcalidrawAssets } from '@/app/lib/excalidraw-collaboration/assets';
import {
  ensureExcalidrawScene,
  loadExcalidrawScene,
} from '@/app/lib/excalidraw-collaboration/repository';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireRuntimeCapability,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import {
  COLLABORATION_SCHEMA_VERSION,
  type CollaborationProvider,
  type CollaborationRepresentation,
  type CollaborationSessionResponse,
} from '@/app/lib/collaboration/types';

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

function validCollaborationRequest(path: string, value: unknown, provider: unknown): {
  representation: CollaborationRepresentation;
  provider: CollaborationProvider;
} | null {
  const ext = extension(path);
  if (ext === 'excalidraw') {
    return value === 'excalidraw_scene' && (provider === undefined || provider === 'excalidraw')
      ? { representation: 'excalidraw_scene', provider: 'excalidraw' }
      : null;
  }
  if (provider !== undefined && provider !== 'yjs') return null;
  if (ext === 'txt') return value === 'plain_text' ? { representation: 'plain_text', provider: 'yjs' } : null;
  if (ext === 'md' || ext === 'markdown') {
    return value === 'plain_text' || value === 'tiptap_xml'
      ? { representation: value, provider: 'yjs' }
      : null;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const rateLimitResponse = applyRateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'collaboration-session',
  });
  if (rateLimitResponse) return rateLimitResponse;

  if (getDatabaseProvider() !== 'postgres' || !workspaceRequiresCollaborationPolicy(workspaceResult.workspace)) {
    return NextResponse.json({ success: false, error: 'Live collaboration requires a shared Postgres workspace.' }, { status: 409 });
  }

  try {
    await requireTeamRuntimeLicense();
    await requireRuntimeCapability('liveCollaboration');
  } catch (error) {
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(licenseEntitlementErrorPayload(error), { status: error.statusCode });
    }
    throw error;
  }

  const body = await readJsonBody<{
    path?: string;
    representation?: CollaborationRepresentation;
    provider?: CollaborationProvider;
  }>(request);
  const path = body.path?.trim();
  const requested = path ? validCollaborationRequest(path, body.representation, body.provider) : null;
  if (!path || !requested) {
    return NextResponse.json({ success: false, error: 'A supported path, provider, and collaboration representation are required.' }, { status: 400 });
  }

  try {
    const collaboration = getFileCollaborationState({
      workspace: workspaceResult.workspace,
      path,
      ensureDocument: true,
    });
    if ((!collaboration.crdtCapable && !collaboration.sceneCapable) || !collaboration.document) {
      return NextResponse.json({ success: false, error: 'This file is not eligible for live collaboration.' }, { status: 409 });
    }
    if (collaboration.document.provider !== requested.provider) {
      return NextResponse.json({ success: false, error: 'The collaboration provider does not match the file identity.' }, { status: 409 });
    }
    const fileOptions = workspaceFileOptions(workspaceResult.workspace);
    let lifecycleGeneration: number;
    if (requested.provider === 'excalidraw') {
      let state = await loadExcalidrawScene(collaboration.document.id);
      if (!state) {
        const initialContent = (await readFile(path, fileOptions)).toString('utf8');
        const initialAssets = await importPortableExcalidrawAssets({
          workspaceId: workspaceResult.workspace.workspaceId,
          content: initialContent,
        });
        state = await ensureExcalidrawScene({
          documentId: collaboration.document.id,
          workspaceId: workspaceResult.workspace.workspaceId,
          organizationId: workspaceResult.workspace.organizationId ?? null,
          path: collaboration.document.path,
          initialContent,
          initialAssets,
        });
      }
      if (state.status !== 'active' || state.workspaceId !== workspaceResult.workspace.workspaceId || state.path !== collaboration.document.path) {
        return NextResponse.json({ success: false, error: 'The Excalidraw collaboration identity or lifecycle is stale.' }, { status: 409 });
      }
      lifecycleGeneration = state.lifecycleGeneration;
    } else {
      let state = await loadCollaborationState(collaboration.document.id);
      if (state) {
        if (
          state.status !== 'active'
          || state.workspaceId !== workspaceResult.workspace.workspaceId
          || state.path !== collaboration.document.path
          || state.representation !== requested.representation
        ) {
          return NextResponse.json({
            success: false,
            error: 'The collaboration document identity, lifecycle, or representation is stale.',
          }, { status: 409 });
        }
      } else {
        const initialContent = (await readFile(path, fileOptions)).toString('utf8');
        if (Buffer.byteLength(initialContent, 'utf8') > 5 * 1024 * 1024) {
          return NextResponse.json({ success: false, error: 'Live collaboration supports text files up to 5 MiB.' }, { status: 413 });
        }
        state = await ensureCollaborationState({
          documentId: collaboration.document.id,
          workspaceId: workspaceResult.workspace.workspaceId,
          organizationId: workspaceResult.workspace.organizationId ?? null,
          path: collaboration.document.path,
          representation: requested.representation as 'plain_text' | 'tiptap_xml',
          initialContent,
        });
      }
      lifecycleGeneration = state.lifecycleGeneration;
    }
    const sessionId = String((workspaceResult.session.session as { id?: string }).id || '');
    if (!sessionId) throw new Error('Authenticated session has no stable identifier.');
    const permission = workspaceResult.workspace.permissions.canWrite ? 'write' : 'read';
    const issued = issueCollaborationTicket({
      userId: workspaceResult.session.user.id,
      sessionId,
      workspaceId: workspaceResult.workspace.workspaceId,
      organizationId: workspaceResult.workspace.organizationId ?? null,
      documentId: collaboration.document.id,
      path: collaboration.document.path,
      provider: requested.provider,
      representation: requested.representation,
      permission,
      lifecycleGeneration,
    });
    const colors = collaborationUserColors(workspaceResult.session.user.id);
    const response: CollaborationSessionResponse = {
      success: true,
      documentId: collaboration.document.id,
      documentName: collaboration.document.id,
      provider: requested.provider,
      representation: requested.representation,
      lifecycleGeneration,
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      permission,
      token: issued.token,
      expiresAt: new Date(issued.claims.expiresAt).toISOString(),
      websocketUrl: requested.provider === 'excalidraw' ? '/ws/collaboration/excalidraw' : '/ws/collaboration',
      user: {
        id: workspaceResult.session.user.id,
        name: workspaceResult.session.user.name || workspaceResult.session.user.email || 'User',
        ...colors,
      },
    };
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const status = code === 'ENOENT' ? 404 : 500;
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Could not start collaboration.',
    }, { status });
  }
}
