import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  createStudioGeneration,
  findStudioGenerationByClientRequestId,
  type StudioGenerateRequest,
} from '@/app/lib/integrations/studio-generation-service';
import { assertStudioGenerationQueueCapacity, enqueueStudioGeneration } from '@/app/lib/integrations/studio-generation-queue';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';

const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

function getClientRequestId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_CLIENT_REQUEST_ID_LENGTH ? normalized : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|unique violation|duplicate key/iu.test(message);
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;

  let body: StudioGenerateRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
    if (!body.product_ids?.length && !body.persona_ids?.length && !body.style_ids?.length && !body.source_output_id && !body.extra_reference_urls?.length && !body.video_reference_urls?.length && !body.audio_reference_urls?.length && !body.video_extend_source_path) {
      return NextResponse.json({ success: false, error: 'Prompt or reference images required' }, { status: 400 });
    }
  }

  const clientRequestId = getClientRequestId(body.client_request_id);
  if (body.client_request_id !== undefined && !clientRequestId) {
    return NextResponse.json({ success: false, error: 'Invalid client request ID' }, { status: 400 });
  }
  if (clientRequestId) {
    body.client_request_id = clientRequestId;
  }

  if (clientRequestId) {
    const existing = await findStudioGenerationByClientRequestId(studioRequest.scope, clientRequestId);
    if (existing) {
      return NextResponse.json({
        success: true,
        generationId: existing.generationId,
        status: existing.status,
        mode: existing.mode,
        prompt: existing.prompt,
        outputs: [],
        reused: true,
      });
    }
  }

  try {
    await assertStudioGenerationQueueCapacity(session.user.id);
    const { generationId, mode, prompt } = await createStudioGeneration(studioRequest.scope, body);
    const queueStatus = enqueueStudioGeneration(generationId);
    await recordAuditEvent({
      userId: session.user.id,
      organizationId: studioRequest.scope.organizationId,
      workspaceId: studioRequest.scope.workspaceId,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation',
      entityId: generationId,
      action: 'studio_generation.create',
      status: 'queued',
      summary: `Studio generation ${generationId} queued.`,
      metadata: {
        mode,
        promptLength: prompt.length,
        productCount: body.product_ids?.length ?? 0,
        personaCount: body.persona_ids?.length ?? 0,
        styleCount: body.style_ids?.length ?? 0,
        referenceCount: (body.extra_reference_urls?.length ?? 0) + (body.video_reference_urls?.length ?? 0) + (body.audio_reference_urls?.length ?? 0),
      },
      input: {
        mode,
        prompt,
        productIds: body.product_ids,
        personaIds: body.persona_ids,
        styleIds: body.style_ids,
      },
    });
    return NextResponse.json({
      success: true,
      generationId,
      status: 'pending',
      mode,
      prompt,
      outputs: [],
      queuePosition: queueStatus.queuePosition,
      queueLength: queueStatus.queueLength,
    }, { status: 201 });
  } catch (error) {
    if (clientRequestId && isUniqueConstraintError(error)) {
      const existing = await findStudioGenerationByClientRequestId(studioRequest.scope, clientRequestId);
      if (existing) {
        return NextResponse.json({
          success: true,
          generationId: existing.generationId,
          status: existing.status,
          mode: existing.mode,
          prompt: existing.prompt,
          outputs: [],
          reused: true,
        });
      }
    }
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: error.code === 'RATE_LIMIT' ? 429 : 400 });
    }
    if (error instanceof IntegrationServiceError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400 });
    }
    console.error('[Studio Generate] Error:', error);
    return NextResponse.json({ success: false, error: 'Generation failed' }, { status: 500 });
  }
}
