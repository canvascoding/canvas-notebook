import { NextRequest, NextResponse } from 'next/server';
import { clearComposioGatewayCaches, connectGatewayToolkit, getComposioGatewayMode } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import { toPublicEffectiveComposioContext } from '@/app/lib/composio/composio-context';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ toolkit: string }> },
) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const composioContext = contextResult.composioContext;
    if ((await getComposioGatewayMode(composioContext)) === 'disabled') {
      return NextResponse.json({ error: 'Composio not configured' }, { status: 400 });
    }

    const { toolkit } = await params;
    if (!toolkit) {
      return NextResponse.json({ error: 'Toolkit slug is required' }, { status: 400 });
    }

    const { redirectUrl, noAuth } = await connectGatewayToolkit(toolkit, composioContext);
    if (noAuth) {
      clearComposioGatewayCaches(composioContext);
      return NextResponse.json({
        noAuth: true,
        redirectUrl: null,
        effectiveProfile: toPublicEffectiveComposioContext(composioContext),
      });
    }
    return NextResponse.json({
      redirectUrl,
      effectiveProfile: toPublicEffectiveComposioContext(composioContext),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
