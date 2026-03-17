import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  generateVideo,
  type GenerateVideoRequestBody,
} from '@/app/lib/integrations/veo-generation-service';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const callerEmail = session.user.email;

  try {
    const limited = rateLimit(request, {
      limit: 10,
      windowMs: 60_000,
      keyPrefix: 'veo-generate',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = (await request.json()) as GenerateVideoRequestBody;
    const data = await generateVideo(body, callerEmail);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('[API] veo/generate error:', error);
    const message = error instanceof Error ? error.message : 'Video generation failed';
    const status = error instanceof IntegrationServiceError ? error.statusCode : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
