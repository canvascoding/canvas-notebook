import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { validateIntegrationConnectionRef } from '@/app/lib/integration-tools/connections/store';
import { captureIntegrationDesktopRequestInitiator } from '@/app/lib/integration-tools/connections/desktop-request';
import { cancelSharedComposioDesktopOAuth, cancelSharedComposioDesktopOAuthIntent, finalizeSharedComposioDesktopOAuth,
  getSharedComposioDesktopOAuthStatus, getSharedComposioDesktopOAuthStatusByIntent } from '@/app/lib/composio/composio-shared-desktop-oauth';
import { sharedComposioExpectedRevisions } from '@/app/lib/composio/composio-shared-account-reference';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { sharedComposioRequestJson, sharedComposioResponse, sharedComposioResponseError } from '@/app/api/composio/shared/http';

const flowSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const workspaceQuerySchema = z.object({ workspaceId: z.string().trim().min(1).max(200)
  .refine(value => !/[\x00-\x1f\x7f]/u.test(value)).optional() }).strict();
const statusQuerySchema = z.union([
  workspaceQuerySchema.extend({ state: flowSchema }).strict(),
  workspaceQuerySchema.extend({ intent: flowSchema }).strict(),
]);
const actionSchema = z.union([
  z.object({ state: flowSchema, action: z.enum(['finalize', 'cancel']) }).strict(),
  z.object({ intent: flowSchema, action: z.literal('cancel'), expectedMetadataRevision: revisionSchema,
    expectedGrantsRevision: revisionSchema, expectedBindingRevision: revisionSchema }).strict(),
]);

function readSharedComposioDesktopQuery(request: Request): Record<string, string> {
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (query.getAll(key).length !== 1) {
      throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Supply each sign-in parameter once.', 400);
    }
  }
  return Object.fromEntries(query);
}

export async function GET(request: NextRequest, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const initiator = await captureIntegrationDesktopRequestInitiator(request); if (initiator instanceof NextResponse) return initiator;
    const limited = rateLimit(request, { limit: 90, windowMs: 60_000, keyPrefix: 'composio-shared-desktop-oauth-status', verifiedUserId: initiator.actor.userId });
    if (!limited.ok) { limited.response.headers.set('Cache-Control', 'no-store'); return limited.response; }
    const input = statusQuerySchema.parse(readSharedComposioDesktopQuery(request));
    const ref = validateIntegrationConnectionRef((await context.params).connectionRef);
    const result = 'state' in input
      ? await getSharedComposioDesktopOAuthStatus(initiator, ref, input.state)
      : await getSharedComposioDesktopOAuthStatusByIntent(initiator, ref, input.intent);
    return sharedComposioResponse(result);
  } catch (error) {
    const response = sharedComposioResponseError(error); response.headers.set('Cache-Control', 'no-store'); return response;
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ connectionRef: string }> }) {
  const origin = requireTrustedMutationOrigin(request); if (!origin.ok) return origin.response;
  try {
    const initiator = await captureIntegrationDesktopRequestInitiator(request); if (initiator instanceof NextResponse) return initiator;
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'composio-shared-desktop-oauth-action', verifiedUserId: initiator.actor.userId });
    if (!limited.ok) { limited.response.headers.set('Cache-Control', 'no-store'); return limited.response; }
    workspaceQuerySchema.parse(readSharedComposioDesktopQuery(request));
    const input = actionSchema.parse(await sharedComposioRequestJson(request));
    const ref = validateIntegrationConnectionRef((await context.params).connectionRef);
    const result = 'intent' in input
      ? await cancelSharedComposioDesktopOAuthIntent(initiator, ref, { intent: input.intent, ...sharedComposioExpectedRevisions(input) })
      : input.action === 'cancel' ? await cancelSharedComposioDesktopOAuth(initiator, ref, input.state)
        : await finalizeSharedComposioDesktopOAuth(initiator, ref, input.state);
    return sharedComposioResponse(result);
  } catch (error) {
    const response = sharedComposioResponseError(error); response.headers.set('Cache-Control', 'no-store'); return response;
  }
}
