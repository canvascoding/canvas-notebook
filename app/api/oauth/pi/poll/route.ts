import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveScopedPiOAuthStatesDir } from '@/app/lib/runtime-data-paths';

function normalizeOAuthFlowId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null;
}

/**
 * GET /api/oauth/pi/poll?flowId=xxx
 * Poll for OAuth flow status and auth URL
 * Returns: { success: boolean, status: string, authUrl?: string, instructions?: string, error?: string }
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
    const flowId = normalizeOAuthFlowId(searchParams.get('flowId'));

    if (!flowId) {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid flowId' },
        { status: 400 }
      );
    }

    const stateFile = join(resolveScopedPiOAuthStatesDir({ userId: session.user.id }), `${flowId}.json`);

    try {
      const stateContent = await readFile(stateFile, 'utf-8');
      const state = JSON.parse(stateContent);

      if (state.userId !== session.user.id) {
        return NextResponse.json(
          { success: false, error: 'Flow not found' },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        flowId,
        status: state.status,
        authUrl: state.authUrl,
        instructions: state.instructions,
        hasCredentials: Boolean(state.hasCredentials),
        error: state.error,
      });
    } catch {
      return NextResponse.json(
        { success: false, error: 'Flow not found' },
        { status: 404 }
      );
    }
  } catch (error) {
    console.error('OAuth poll failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to poll OAuth status' },
      { status: 500 }
    );
  }
}
