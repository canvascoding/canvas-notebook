import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { deleteToken } from '@/app/lib/oauth/store';

/**
 * POST /api/oauth/openai-codex/disconnect
 * Disconnect OAuth and delete stored token
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

    await deleteToken('openai-codex');

    return NextResponse.json({
      success: true,
      message: 'Disconnected successfully',
    });
  } catch (error) {
    console.error('OAuth disconnect failed:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to disconnect' },
      { status: 500 }
    );
  }
}
