import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AD_LOCALIZATION_ALL_FAILED_MESSAGE,
  localizeAd,
  type LocalizeAdRequestBody,
} from '@/app/lib/integrations/ad-localization-service';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const callerEmail = session.user.email;

  try {
    const limited = rateLimit(request, {
      limit: 6,
      windowMs: 60_000,
      keyPrefix: 'nano-banana-localize',
    });
    if (!limited.ok) {
      return limited.response;
    }

    let body: LocalizeAdRequestBody;
    try {
      body = (await request.json()) as LocalizeAdRequestBody;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON payload.' }, { status: 400 });
    }
    const data = await localizeAd(body, callerEmail);
    if (data.successCount === 0) {
      return NextResponse.json(
        {
          success: false,
          error: AD_LOCALIZATION_ALL_FAILED_MESSAGE,
          data,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('[API] nano-banana/localize error:', error);
    const message = error instanceof Error ? error.message : 'Localization failed';
    const status = error instanceof IntegrationServiceError ? error.statusCode : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
