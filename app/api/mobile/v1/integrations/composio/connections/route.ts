import { NextRequest, NextResponse } from 'next/server';

import {
  clearComposioGatewayCaches,
  connectGatewayToolkit,
  getGatewayStatus,
} from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';

export async function POST(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const body = await request.json() as { toolkit?: unknown; returnUrl?: unknown };
    if (typeof body.toolkit !== 'string' || !body.toolkit.trim()) {
      return NextResponse.json({ success: false, error: 'toolkit is required' }, { status: 400 });
    }
    if (typeof body.returnUrl !== 'string' || !body.returnUrl.trim()) {
      return NextResponse.json({ success: false, error: 'returnUrl is required' }, { status: 400 });
    }
    const status = await getGatewayStatus(contextResult.composioContext);
    if (!status.configured || !status.apiKeyValid) {
      return NextResponse.json({ success: false, error: 'Connected apps are not configured' }, { status: 409 });
    }

    const toolkit = body.toolkit.trim().toLowerCase();
    const result = await connectGatewayToolkit(toolkit, contextResult.composioContext, {
      mobileReturnUrl: body.returnUrl.trim(),
    });
    if (result.noAuth) clearComposioGatewayCaches(contextResult.composioContext);

    return NextResponse.json({
      success: true,
      connection: {
        toolkit,
        noAuth: result.noAuth === true,
        redirectUrl: result.redirectUrl || '',
        flowId: 'flowId' in result && typeof result.flowId === 'string' ? result.flowId : '',
        expiresAt: 'expiresAt' in result && typeof result.expiresAt === 'string' ? result.expiresAt : '',
        status: result.noAuth ? 'active' : 'pending',
      },
    }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    });
  } catch (error) {
    console.error('[Mobile Composio Connection API] Error:', error);
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500;
    return NextResponse.json({
      success: false,
      error: status < 500 && error instanceof Error ? error.message : 'Failed to start app connection',
    }, { status });
  }
}
