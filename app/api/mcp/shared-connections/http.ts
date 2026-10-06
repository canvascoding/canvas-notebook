import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resourceRequestActor, resourceRequestJson, resourceResponse } from '@/app/api/capabilities/resources/http';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { IntegrationConnectionError, isIntegrationConnectionError, type IntegrationConnectionActor, type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';
import { readIntegrationContractErrorCode } from '@/app/lib/integration-tools/agent-errors';

export { resourceRequestActor as sharedMcpRequestActor, resourceRequestJson as sharedMcpRequestJson, resourceResponse as sharedMcpResponse };
export const sharedMcpRevisionSchema = { expectedMetadataRevision: z.number().int().positive(), expectedGrantsRevision: z.number().int().positive(), expectedBindingRevision: z.number().int().positive() };
export const sharedMcpOwnershipSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('organization') }).strict(),
  z.object({ type: z.literal('team'), workspaceId: z.string().min(1).max(256) }).strict()]);
export const sharedMcpGrantsSchema = z.array(z.object({ targetType: z.enum(['organization', 'role', 'workspace', 'project', 'user', 'agent']),
  targetId: z.string().min(1).max(256), canUse: z.boolean(), canManage: z.boolean(), allowedToolNames: z.array(z.string().min(1).max(512)).max(1000).nullable() }).strict()).max(100);
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
