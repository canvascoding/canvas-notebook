import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { createStudioGeneration, type StudioGenerateRequest } from '@/app/lib/integrations/studio-generation-service';
import { assertStudioGenerationQueueCapacity, enqueueStudioGeneration } from '@/app/lib/integrations/studio-generation-queue';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

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

  try {
    await assertStudioGenerationQueueCapacity(session.user.id);
    const { generationId, mode, prompt } = await createStudioGeneration(session.user.id, body);
    const queueStatus = enqueueStudioGeneration(generationId);
    await recordAuditEvent({
      userId: session.user.id,
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
