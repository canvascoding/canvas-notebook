import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { createStudioGeneration, runStudioGeneration, type StudioGenerateRequest } from '@/app/lib/integrations/studio-generation-service';
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
    if (!body.product_ids?.length && !body.persona_ids?.length && !body.source_output_id && !body.extra_reference_urls?.length) {
      return NextResponse.json({ success: false, error: 'Prompt or reference images required' }, { status: 400 });
    }
  }

  try {
    const { generationId, mode, prompt } = await createStudioGeneration(session.user.id, body);
    runStudioGeneration(generationId).catch((err) => {
      console.error('[Studio Generate] Background generation failed:', err);
    });
    return NextResponse.json({
      success: true,
      generationId,
      status: 'pending',
      mode,
      prompt,
      outputs: [],
    }, { status: 201 });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    if (error instanceof IntegrationServiceError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400 });
    }
    console.error('[Studio Generate] Error:', error);
    return NextResponse.json({ success: false, error: 'Generation failed' }, { status: 500 });
  }
}