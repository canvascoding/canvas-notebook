import { NextRequest, NextResponse } from 'next/server';
import { consumeComposioOAuthFlowState } from '@/app/lib/composio/composio-oauth-state';
import { clearComposioGatewayCaches } from '@/app/lib/composio/composio-gateway';
import { composioContextFromEffectiveProfile } from '@/app/lib/composio/composio-context';
import { ComposioProfileError, resolveEffectiveComposioProfile } from '@/app/lib/composio/composio-profiles';

function getBaseUrl(): string {
  const baseUrl = process.env.BASE_URL || process.env.APP_BASE_URL;
  if (baseUrl) return baseUrl;
  const port = process.env.PORT || '3000';
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return `http://localhost:${port}`;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const flowState = await consumeComposioOAuthFlowState({
      state: url.searchParams.get('flow') || '',
    });
    const effective = await resolveEffectiveComposioProfile({
      userId: flowState.userId,
      workspaceId: flowState.workspaceId,
    });
    const context = effective.id === flowState.profileId
      ? composioContextFromEffectiveProfile(flowState.userId, effective)
      : null;
    clearComposioGatewayCaches(context);

    const redirectUrl = flowState.returnPath.startsWith('/')
      ? new URL(flowState.returnPath, getBaseUrl())
      : new URL(flowState.returnPath);
    redirectUrl.searchParams.set('composio', 'returned');
    redirectUrl.searchParams.set('toolkit', flowState.toolkitSlug);

    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      error: message,
      code: error instanceof ComposioProfileError ? error.code : 'COMPOSIO_CALLBACK_FAILED',
    }, { status: error instanceof ComposioProfileError ? error.status : 500 });
  }
}
