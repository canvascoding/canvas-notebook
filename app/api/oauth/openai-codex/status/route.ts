import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getValidToken } from '@/app/lib/oauth/store';

/**
 * GET /api/oauth/openai-codex/status
 * Get OAuth connection status
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

    const token = await getValidToken('openai-codex');
    
    return NextResponse.json({
      connected: !!token,
      email: token?.email,
      expiresAt: token?.expiresAt,
    });
  } catch (error) {
    console.error('OAuth status check failed:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to check status' },
      { status: 500 }
    );
  }
}
