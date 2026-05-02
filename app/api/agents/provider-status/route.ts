import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getProviderHelp, requiresApiKey, requiresCliAuth } from '@/app/lib/pi/provider-help';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { hasProviderCredentials, isOAuthProvider } from '@/app/lib/pi/oauth';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';

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

    // Check if the user has explicitly chosen OAuth mode for dual-auth providers
    let preferredAuthMethod: string | undefined;
    try {
      const piConfig = await readPiRuntimeConfig();
      preferredAuthMethod = piConfig.providers[providerId]?.authMethod;
    } catch {
      // Config read failed, continue with default behavior
    }

    const isOAuthMode = preferredAuthMethod === 'oauth';
    const isProviderOAuth = isOAuthProvider(providerId);

    // If user selected OAuth mode for a dual-auth provider, only check OAuth readiness
    const requiresKey = isOAuthMode ? false : requiresApiKey(providerId);
    // Check if provider requires OAuth (either legacy CLI auth or PI OAuth)
    const requiresOAuth = requiresCliAuth(providerId) || isProviderOAuth || isOAuthMode;

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
      // Check if provider is a PI OAuth provider
      if (isOAuthProvider(providerId)) {
        hasOAuth = hasProviderCredentials(providerId);
      }
      if (!hasOAuth && isOAuthMode) {
        issues.push('OAuth not connected. Click "Connect Account" to link your subscription.');
      } else if (!hasOAuth) {
        issues.push('OAuth not connected. Please connect your account below.');
      }
    }

    if (requiresKey && !hasApiKey && !isOAuthMode) {
      // Issue already added above
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
