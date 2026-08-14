import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { jsonServerError } from '@/app/lib/api/route-helpers';
import { 
  removeProviderCredentials,
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
} from '@/app/lib/pi/oauth';

/**
 * POST /api/oauth/pi/disconnect
 * Disconnect OAuth for a provider
 * Body: { provider: string }
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

    const { provider } = await request.json();

    if (!provider || !isOAuthProvider(provider)) {
      return NextResponse.json(
        { success: false, error: `Invalid provider. Supported: ${PI_OAUTH_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    // Remove credentials
    await removeProviderCredentials(provider, { userId: session.user.id });

    return NextResponse.json({
      success: true,
      message: `Successfully disconnected from ${provider}`,
    });
  } catch (error) {
    return jsonServerError('[OAuth disconnect] Failed to disconnect OAuth:', error, 'Failed to disconnect OAuth');
  }
}
