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
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireRuntimeCapability,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import {
  COLLABORATION_SCHEMA_VERSION,
  type CollaborationRepresentation,
  type CollaborationSessionResponse,
} from '@/app/lib/collaboration/types';

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

function validRepresentation(path: string, value: unknown): CollaborationRepresentation | null {
  const ext = extension(path);
  if (ext === 'txt') return value === 'plain_text' ? 'plain_text' : null;
  if (ext === 'md' || ext === 'markdown') {
    return value === 'plain_text' || value === 'tiptap_xml' ? value : null;
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

  const body = await readJsonBody<{ path?: string; representation?: CollaborationRepresentation }>(request);
  const path = body.path?.trim();
  const representation = path ? validRepresentation(path, body.representation) : null;
  if (!path || !representation) {
    return NextResponse.json({ success: false, error: 'A Markdown/text path and valid collaboration representation are required.' }, { status: 400 });
  }

  try {
    const collaboration = getFileCollaborationState({
      workspace: workspaceResult.workspace,
      path,
      ensureDocument: true,
    });
    if (!collaboration.crdtCapable || !collaboration.document) {
      return NextResponse.json({ success: false, error: 'This file is not eligible for text collaboration.' }, { status: 409 });
    }

    let state = await loadCollaborationState(collaboration.document.id);
    if (state) {
      if (
        state.status !== 'active'
        || state.workspaceId !== workspaceResult.workspace.workspaceId
        || state.path !== collaboration.document.path
        || state.representation !== representation
      ) {
        return NextResponse.json({
          success: false,
          error: 'The collaboration document identity, lifecycle, or representation is stale.',
        }, { status: 409 });
      }
    } else {
      const fileOptions = workspaceFileOptions(workspaceResult.workspace);
      const initialContent = (await readFile(path, fileOptions)).toString('utf8');
      if (Buffer.byteLength(initialContent, 'utf8') > 5 * 1024 * 1024) {
        return NextResponse.json({ success: false, error: 'Live collaboration supports text files up to 5 MiB.' }, { status: 413 });
      }
      state = await ensureCollaborationState({
        documentId: collaboration.document.id,
        workspaceId: workspaceResult.workspace.workspaceId,
        organizationId: workspaceResult.workspace.organizationId ?? null,
        path: collaboration.document.path,
        representation,
        initialContent,
      });
    }
    const sessionId = String((workspaceResult.session.session as { id?: string }).id || '');
    if (!sessionId) throw new Error('Authenticated session has no stable identifier.');
    const permission = workspaceResult.workspace.permissions.canWrite ? 'write' : 'read';
    const issued = issueCollaborationTicket({
      userId: workspaceResult.session.user.id,
      sessionId,
      workspaceId: state.workspaceId,
      organizationId: state.organizationId,
      documentId: state.documentId,
      path: state.path,
      representation: state.representation,
      permission,
      lifecycleGeneration: state.lifecycleGeneration,
    });
    const colors = collaborationUserColors(workspaceResult.session.user.id);
    const response: CollaborationSessionResponse = {
      success: true,
      documentId: state.documentId,
      documentName: state.documentId,
      representation: state.representation,
      lifecycleGeneration: state.lifecycleGeneration,
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      permission,
      token: issued.token,
      expiresAt: new Date(issued.claims.expiresAt).toISOString(),
      websocketUrl: '/ws/collaboration',
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
