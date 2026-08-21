import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import {
  CollaborationSessionError,
  createCollaborationSessionGrant,
  parseCollaborationSessionRequest,
} from '@/app/lib/collaboration/session-service';
import {
  COLLABORATION_SCHEMA_VERSION,
  RICH_MARKDOWN_SCHEMA_VERSION,
  type CollaborationSessionResponse,
} from '@/app/lib/collaboration/types';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import { workspaceRequiresCollaborationPolicy } from '@/app/lib/files/collaboration-policy';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireRuntimeCapability,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import { issueMobileCollaborationTicket } from '@/app/lib/mobile/collaboration-ticket';
import { readFile } from '@/app/lib/filesystem/workspace-files';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-notebook-collaboration-session',
  });
  if (limited) return limited;

  if (
    getDatabaseProvider() !== 'postgres'
    || !workspaceRequiresCollaborationPolicy(workspaceResult.workspace)
  ) {
    return NextResponse.json(
      { success: false, error: 'Live collaboration requires a shared Postgres workspace.' },
      { status: 409 },
    );
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

  const body = await readJsonBody<{ path?: unknown }>(request);
  const requestedPath = typeof body.path === 'string' ? body.path.trim().toLowerCase() : '';
  const preliminaryRequest = parseCollaborationSessionRequest({
    path: body.path,
    provider: 'yjs',
    representation: requestedPath.endsWith('.txt') ? 'plain_text' : 'tiptap_xml',
  });
  if (!preliminaryRequest) {
    return NextResponse.json(
      { success: false, error: 'A supported Markdown or plain-text path is required.' },
      { status: 400 },
    );
  }
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);
  const representation = requestedPath.endsWith('.txt')
    ? 'plain_text'
    : analyzeMarkdownRichMode((await readFile(preliminaryRequest.path, fileOptions)).toString('utf8')).mode === 'source'
      ? 'plain_text'
      : 'tiptap_xml';
  const collaborationRequest = parseCollaborationSessionRequest({
    path: body.path,
    provider: 'yjs',
    representation,
  });
  if (!collaborationRequest) {
    return NextResponse.json(
      { success: false, error: 'A supported Markdown or plain-text path is required.' },
      { status: 400 },
    );
  }

  try {
    const grant = await createCollaborationSessionGrant({
      workspace: workspaceResult.workspace,
      fileOptions,
      request: collaborationRequest,
    });
    const sessionId = String((workspaceResult.session.session as { id?: string }).id || '');
    if (!sessionId) throw new Error('Authenticated session has no stable identifier.');

    const ticket = issueMobileCollaborationTicket({
      claims: {
        userId: workspaceResult.session.user.id,
        sessionId,
        workspaceId: workspaceResult.workspace.workspaceId,
        organizationId: workspaceResult.workspace.organizationId ?? null,
        documentId: grant.documentId,
        path: grant.path,
        provider: grant.provider,
        representation: grant.representation,
        permission: grant.permission,
        lifecycleGeneration: grant.lifecycleGeneration,
      },
      user: {
        id: workspaceResult.session.user.id,
        name: workspaceResult.session.user.name
          || workspaceResult.session.user.email
          || 'User',
        email: workspaceResult.session.user.email || null,
        role: workspaceResult.session.user.role || null,
      },
    });
    const colors = collaborationUserColors(workspaceResult.session.user.id);
    const response: CollaborationSessionResponse = {
      success: true,
      documentId: grant.documentId,
      documentName: grant.documentName,
      provider: grant.provider,
      representation: grant.representation,
      lifecycleGeneration: grant.lifecycleGeneration,
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      richTextSchemaVersion: RICH_MARKDOWN_SCHEMA_VERSION,
      permission: grant.permission,
      token: ticket.token,
      expiresAt: ticket.expiresAt,
      websocketUrl: '/ws/collaboration',
      user: {
        id: workspaceResult.session.user.id,
        name: workspaceResult.session.user.name
          || workspaceResult.session.user.email
          || 'User',
        ...colors,
      },
    };
    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    const status = error instanceof CollaborationSessionError
      ? error.status
      : code === 'ENOENT' ? 404 : 500;
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Could not start collaboration.',
      ...(error instanceof CollaborationSessionError && error.code ? { code: error.code } : {}),
    }, { status });
  }
}
