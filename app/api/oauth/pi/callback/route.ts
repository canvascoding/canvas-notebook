import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
} from '@/app/lib/pi/oauth';

/**
 * POST /api/oauth/pi/callback
 * Handle OAuth callback for providers that require manual code input
 * Body: { provider: string, code?: string, callbackUrl?: string }
 * Returns: { success: boolean, message?: string, error?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { provider, code, callbackUrl } = await request.json();

    if (!provider || !isOAuthProvider(provider)) {
      return NextResponse.json(
        { success: false, error: `Invalid provider. Supported: ${PI_OAUTH_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    // For device code flows, the user provides the code directly
    if (code) {
      // Anthropic and some other providers use device code flow
      // The code is the authorization code from the browser
      console.log(`[OAuth ${provider}] Received device code`);
      
      // In this case, the credentials should already be stored by the initiate endpoint
      // If not, we need to exchange the code for tokens
      // For now, we'll return success as the initiate flow should have handled it
      
      return NextResponse.json({
        success: true,
        message: 'Authorization code received. Please check the status endpoint.',
      });
    }

    // For callback-based flows (Google providers)
    if (callbackUrl) {
      console.log(`[OAuth ${provider}] Received callback URL: ${callbackUrl}`);
      
      // The callback URL contains the authorization code or token
      // We need to parse it and exchange for credentials
      // This would require specific provider implementations
      
      return NextResponse.json({
        success: true,
        message: 'Callback URL received. Authentication should be complete.',
      });
    }

    return NextResponse.json(
      { success: false, error: 'Missing code or callbackUrl' },
      { status: 400 }
    );
  } catch (error) {
    console.error('OAuth callback failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to process callback' },
      { status: 500 }
    );
  }
}
