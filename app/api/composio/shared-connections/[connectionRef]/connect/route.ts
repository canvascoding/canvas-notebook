import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectSharedComposioConnection } from '@/app/lib/composio/composio-shared-connections';
import { startSharedComposioDesktopOAuth } from '@/app/lib/composio/composio-shared-desktop-oauth';
import { sharedComposioExpectedRevisions } from '@/app/lib/composio/composio-shared-account-reference';
import { captureIntegrationDesktopRequestInitiator } from '@/app/lib/integration-tools/connections/desktop-request';
import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { validateIntegrationConnectionRef } from '@/app/lib/integration-tools/connections/store';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { sharedComposioRequestActor, sharedComposioRequestJson, sharedComposioResponse, sharedComposioResponseError, sharedComposioRevisionSchema } from '../../../shared/http';

const desktopStartSchema = z.object({ desktop: z.literal(true),
  intent: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
  expectedMetadataRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedGrantsRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedBindingRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  let desktop = false;
  try {
    // Inspect a clone so legacy browser requests retain authentication before JSON validation.
    const candidate: unknown = await request.clone().json().catch(() => undefined);
    desktop = Boolean(candidate && typeof candidate === 'object' && 'desktop' in candidate && candidate.desktop === true);
    if (desktop) {
      const desktopRequest = new NextRequest(request.url, { headers: request.headers });
      const origin = requireTrustedMutationOrigin(desktopRequest); if (!origin.ok) return origin.response;
      const initiator = await captureIntegrationDesktopRequestInitiator(request); if (initiator instanceof NextResponse) return initiator;
      const limited = rateLimit(desktopRequest, { limit: 30, windowMs: 60_000, keyPrefix: 'composio-shared-desktop-oauth-start', verifiedUserId: initiator.actor.userId });
      if (!limited.ok) { limited.response.headers.set('Cache-Control', 'no-store'); return limited.response; }
      const query = new URL(request.url).searchParams;
      for (const key of query.keys()) {
        if (query.getAll(key).length !== 1) throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Supply each sign-in parameter once.', 400);
      }
      z.object({ workspaceId: z.string().trim().min(1).max(200)
        .refine(value => !/[\x00-\x1f\x7f]/u.test(value)).optional() }).strict().parse(Object.fromEntries(query));
      const input = desktopStartSchema.parse(candidate);
      const ref = validateIntegrationConnectionRef((await context.params).connectionRef);
      return sharedComposioResponse(await startSharedComposioDesktopOAuth(initiator, ref,
        { intent: input.intent, ...sharedComposioExpectedRevisions(input) }));
    }
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const input = z.object({ ...sharedComposioRevisionSchema, returnPath: z.string().min(1).max(2048).optional(), returnLocale: z.enum(['de', 'en']).optional(), catalogReturnPath: z.string().min(1).max(4096).optional() }).strict().parse(await sharedComposioRequestJson(request));
    return sharedComposioResponse(await connectSharedComposioConnection(actor, (await context.params).connectionRef,
      { revisions: sharedComposioExpectedRevisions(input), returnPath: input.returnPath, returnLocale: input.returnLocale, catalogReturnPath: input.catalogReturnPath }));
  } catch (error) {
    const response = sharedComposioResponseError(error); if (desktop) response.headers.set('Cache-Control', 'no-store'); return response;
  }
}
