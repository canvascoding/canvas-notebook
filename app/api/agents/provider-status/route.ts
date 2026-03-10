import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getProviderHelp, requiresApiKey, requiresCliAuth } from '@/app/lib/pi/provider-help';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { getValidToken } from '@/app/lib/oauth/store';

/**
 * GET /api/agents/provider-status?providerId=openai-codex
 * Check the configuration status of a specific provider
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const providerId = searchParams.get('providerId');

    if (!providerId) {
      return NextResponse.json(
        { success: false, error: 'Missing providerId parameter' },
        { status: 400 }
      );
    }

    const help = getProviderHelp(providerId);
    if (!help) {
      return NextResponse.json(
        { success: false, error: 'Unknown provider' },
        { status: 400 }
      );
    }

    const requiresKey = requiresApiKey(providerId);
    const requiresOAuth = requiresCliAuth(providerId) && providerId === 'openai-codex';

    let hasApiKey = false;
    let hasOAuth = false;
    const issues: string[] = [];

    if (requiresKey) {
      const apiKey = await resolvePiApiKey(providerId);
      hasApiKey = !!apiKey;
      if (!hasApiKey) {
        issues.push(`API key not configured for ${providerId}`);
      }
    }

    if (requiresOAuth) {
      const token = await getValidToken('openai-codex');
      hasOAuth = !!token;
      if (!hasOAuth) {
        issues.push('OAuth not connected. Please connect your OpenAI account.');
      }
    }

    const isReady = (requiresKey && hasApiKey) || (requiresOAuth && hasOAuth) || (!requiresKey && !requiresOAuth);

    return NextResponse.json({
      success: true,
      providerId,
      isReady,
      hasApiKey,
      hasOAuth,
      requiresKey,
      requiresOAuth,
      issues,
    });
  } catch (error) {
    console.error('Provider status check failed:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to check provider status' },
      { status: 500 }
    );
  }
}
