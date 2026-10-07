import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/app/lib/auth';
import { resourceRequestActor, resourceRequestJson, resourceResponse } from '@/app/api/capabilities/resources/http';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { IntegrationConnectionError, isIntegrationConnectionError, type IntegrationConnectionActor, type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';
import { readIntegrationContractErrorCode } from '@/app/lib/integration-tools/agent-errors';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import type { SharedMcpDesktopInitiator } from '@/app/lib/mcp/shared-desktop-oauth-contract';

export { resourceRequestActor as sharedMcpRequestActor, resourceRequestJson as sharedMcpRequestJson, resourceResponse as sharedMcpResponse };
export const sharedMcpRevisionSchema = { expectedMetadataRevision: z.number().int().positive(), expectedGrantsRevision: z.number().int().positive(), expectedBindingRevision: z.number().int().positive() };
export const sharedMcpOwnershipSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('organization') }).strict(),
  z.object({ type: z.literal('team'), workspaceId: z.string().min(1).max(256) }).strict()]);
export const sharedMcpGrantsSchema = z.array(z.object({ targetType: z.enum(['organization', 'role', 'workspace', 'project', 'user', 'agent']),
  targetId: z.string().min(1).max(256), canUse: z.boolean(), canManage: z.boolean(), allowedToolNames: z.array(z.string().min(1).max(512)).max(1000).nullable() }).strict()).max(100);

/** Actor and original authentication session come from one server-verified identity. */
export async function sharedMcpRequestDesktopInitiator(request: Request): Promise<SharedMcpDesktopInitiator | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  const expiresAt = session?.session ? new Date(session.session.expiresAt).getTime() : Number.NaN;
  if (!session || typeof session.session?.id !== 'string' || !session.session.id.trim()
    || session.session.userId !== session.user.id || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return NextResponse.json({ success: false, code: 'unauthorized', error: 'Sign in to manage shared sign-in.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const query = new URL(request.url).searchParams;
  if (query.getAll('workspaceId').length > 1) throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Supply one workspace selection.', 400);
  const headerWorkspaceId = request.headers.get(WORKSPACE_ID_HEADER)?.trim() || null;
  const queryWorkspaceId = query.get('workspaceId')?.trim() || null;
  if (headerWorkspaceId && queryWorkspaceId && headerWorkspaceId !== queryWorkspaceId) {
    throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Workspace selections do not match.', 400);
  }
  const workspaceId = headerWorkspaceId || queryWorkspaceId;
  if (workspaceId && (workspaceId.length > 200 || /[\x00-\x1f\x7f]/u.test(workspaceId))) {
    throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Invalid workspace selection.', 400);
  }
  return { actor: { userId: session.user.id, workspaceId }, authSessionId: session.session.id };
}
export function sharedMcpRevisions(input: z.infer<z.ZodObject<typeof sharedMcpRevisionSchema>>) {
  return { metadataRevision: input.expectedMetadataRevision, grantsRevision: input.expectedGrantsRevision, bindingRevision: input.expectedBindingRevision };
}
export async function sharedMcpRequestOwnership(actor: IntegrationConnectionActor,
  choice: z.infer<typeof sharedMcpOwnershipSchema>): Promise<SharedIntegrationConnectionOwnership> {
  const state = await readOrganizationPermissionForUser(actor.userId);
  if (!state.configured || state.permission?.status !== 'active' || !state.organizationId) throw new IntegrationConnectionError('CONNECTION_ACCESS_DENIED', 'An active organization membership is required.', 403);
  return choice.type === 'team' ? { type: 'team', organizationId: state.organizationId, workspaceId: choice.workspaceId }
    : { type: 'organization', organizationId: state.organizationId };
}
export function sharedMcpResponseError(error: unknown): NextResponse {
  if (isIntegrationConnectionError(error) || error instanceof CapabilityResourceError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  }
  const integrationCode = readIntegrationContractErrorCode(error);
  if (integrationCode) return NextResponse.json({ success: false, code: integrationCode,
    error: integrationCode === 'binding_changed' ? 'The shared connection changed. Reload or repair its setup.' : 'The shared MCP operation is not available in this context.' },
  { status: integrationCode === 'binding_changed' ? 409 : integrationCode === 'provider_denied' ? 403 : 503, headers: { 'Cache-Control': 'no-store' } });
  if (error instanceof z.ZodError) return NextResponse.json({ success: false, code: 'invalid_request', error: 'The shared MCP request is invalid.' }, { status: 400 });
  console.error('[SharedMcp] Request failed.', { errorType: error instanceof Error ? error.name : 'UnknownError' });
  return NextResponse.json({ success: false, code: 'provider_unavailable', error: 'The shared MCP operation is unavailable.' }, { status: 503 });
}
