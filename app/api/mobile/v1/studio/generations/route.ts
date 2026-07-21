import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { auth } from '@/app/lib/auth';
import {
  createStudioGeneration,
} from '@/app/lib/integrations/studio-generation-service';
import {
  assertStudioGenerationQueueCapacity,
  enqueueStudioGeneration,
} from '@/app/lib/integrations/studio-generation-queue';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import {
  listMobileStudioGenerations,
  resolveMobileStudioGenerationRequest,
} from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json(
    { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
    { status: 401, headers: mobileStudioResponseHeaders },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-studio-list' });
  if (limited) return limited;
  try {
    const result = await listMobileStudioGenerations({
      scope: studioRequest.scope,
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: request.nextUrl.searchParams.get('limit'),
    });
    return NextResponse.json({ success: true, ...result }, { headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio list failed:');
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  const limited = applyRateLimit(request, { limit: 15, windowMs: 60_000, keyPrefix: 'mobile-studio-create' });
  if (limited) return limited;
  try {
    const input = await resolveMobileStudioGenerationRequest(await request.json().catch(() => null), studioRequest.scope);
    await assertStudioGenerationQueueCapacity(session.user.id);
    const generation = await createStudioGeneration(studioRequest.scope, input);
    const queue = enqueueStudioGeneration(generation.generationId);
    await recordAuditEvent({
      userId: session.user.id,
      organizationId: studioRequest.scope.organizationId,
      workspaceId: studioRequest.scope.workspaceId,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation',
      entityId: generation.generationId,
      action: 'studio_generation.mobile_create',
      status: 'queued',
      summary: `Mobile Studio generation ${generation.generationId} queued.`,
      metadata: {
        mode: generation.mode,
        promptLength: generation.prompt.length,
        referenceCount: (input.extra_reference_urls?.length || 0)
          + (input.video_reference_urls?.length || 0)
          + (input.audio_reference_urls?.length || 0),
      },
    });
    return NextResponse.json({
      success: true,
      generation: {
        id: generation.generationId,
        mode: generation.mode,
        status: 'pending',
        queuePosition: queue.queuePosition,
        queueLength: queue.queueLength,
      },
    }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio create failed:');
  }
}
