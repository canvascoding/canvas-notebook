import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  getAllProviderStatus,
  isOAuthProvider,
} from '@/app/lib/pi/oauth';

/**
 * GET /api/oauth/pi/status
 * Get OAuth status for all PI providers or a specific provider
 * Query: ?provider=openai-codex (optional)
 * Returns: { success: boolean, providers?: Array, provider?: object, error?: string }
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
    const provider = searchParams.get('provider');

    if (provider) {
      // Return status for specific provider
      if (!isOAuthProvider(provider)) {
        return NextResponse.json(
          { success: false, error: `Invalid provider: ${provider}` },
          { status: 400 }
        );
      }

      const allStatus = getAllProviderStatus();
      const providerStatus = allStatus.find(p => p.provider === provider);

      if (!providerStatus) {
        return NextResponse.json(
          { success: false, error: `Provider not found: ${provider}` },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        provider: providerStatus,
      });
    }

    // Return status for all providers
    const allStatus = getAllProviderStatus();
    
    return NextResponse.json({
      success: true,
      providers: allStatus,
    });
  } catch (error) {
    console.error('OAuth status check failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to get OAuth status' },
      { status: 500 }
    );
  }
}
