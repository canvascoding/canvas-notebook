import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resourceRequestActor, resourceRequestJson, resourceResponse } from '@/app/api/capabilities/resources/http';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { IntegrationConnectionError, isIntegrationConnectionError, type IntegrationConnectionActor, type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';
import { ComposioProfileError } from '@/app/lib/composio/composio-profiles';

export { resourceRequestActor as sharedComposioRequestActor, resourceRequestJson as sharedComposioRequestJson, resourceResponse as sharedComposioResponse };
export const sharedComposioRevisionSchema = { expectedMetadataRevision: z.number().int().positive(), expectedGrantsRevision: z.number().int().positive(), expectedBindingRevision: z.number().int().positive() };
export const sharedComposioOwnershipSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('organization') }).strict(),
  z.object({ type: z.literal('team'), workspaceId: z.string().min(1).max(256) }).strict()]);

export async function sharedComposioRequestOwnership(actor: IntegrationConnectionActor,
  choice: z.infer<typeof sharedComposioOwnershipSchema>): Promise<SharedIntegrationConnectionOwnership> {
  const state = await readOrganizationPermissionForUser(actor.userId);
  if (!state.configured || state.permission?.status !== 'active' || !state.organizationId) throw new IntegrationConnectionError('provider_denied', 'An active organization membership is required.', 403);
  return choice.type === 'team' ? { type: 'team', organizationId: state.organizationId, workspaceId: choice.workspaceId }
    : { type: 'organization', organizationId: state.organizationId };
}

export function sharedComposioResponseError(error: unknown): NextResponse {
  if (isIntegrationConnectionError(error) || error instanceof CapabilityResourceError || error instanceof ComposioProfileError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  }
  if (error instanceof z.ZodError) return NextResponse.json({ success: false, code: 'invalid_request', error: 'The shared Composio request is invalid.' }, { status: 400 });
  console.error('[SharedComposio] Request failed.', { errorType: error instanceof Error ? error.name : 'UnknownError' });
  return NextResponse.json({ success: false, code: 'provider_unavailable', error: 'The shared Composio operation is unavailable.' }, { status: 503 });
}
