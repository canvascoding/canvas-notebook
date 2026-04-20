import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { executeStudioGeneration, type StudioGenerateRequest } from '@/app/lib/integrations/studio-generation-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

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
    if (!body.product_ids?.length && !body.persona_ids?.length && !body.source_output_id) {
      return NextResponse.json({ success: false, error: 'Prompt or reference images required' }, { status: 400 });
    }
  }

  try {
    const result = await executeStudioGeneration(session.user.id, body);
    return NextResponse.json({
      success: true,
      generationId: result.generationId,
      status: result.status,
      mode: result.mode,
      prompt: result.prompt,
      outputs: result.outputs,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    console.error('[Studio Generate] Error:', error);
    return NextResponse.json({ success: false, error: 'Generation failed' }, { status: 500 });
  }
}