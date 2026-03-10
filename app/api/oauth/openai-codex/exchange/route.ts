import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { verifyOAuthState, exchangeCodeForToken } from '@/app/lib/oauth/codex';
import { storeToken } from '@/app/lib/oauth/store';
import crypto from 'crypto';

/**
 * POST /api/oauth/openai-codex/exchange
 * Exchange callback URL for token
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

    const { callbackUrl } = await request.json();
    
    if (!callbackUrl) {
      return NextResponse.json(
        { success: false, error: 'Missing callbackUrl' },
        { status: 400 }
      );
    }

    // Parse callback URL
    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    
    if (error) {
      return NextResponse.json(
        { success: false, error: `OAuth error: ${error}` },
        { status: 400 }
      );
    }
    
    if (!code || !state) {
      return NextResponse.json(
        { success: false, error: 'Missing code or state in callback URL' },
        { status: 400 }
      );
    }

    // Verify state and get code verifier
    const codeVerifier = verifyOAuthState(state, session.user.id);
    
    if (!codeVerifier) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired state' },
        { status: 400 }
      );
    }

    // Exchange code for token
    const tokenData = await exchangeCodeForToken(code, codeVerifier);
    
    if (!tokenData) {
      return NextResponse.json(
        { success: false, error: 'Failed to exchange code for token' },
        { status: 500 }
      );
    }

    // Store token
    const token: import('@/app/lib/oauth/store').OAuthToken = {
      id: crypto.randomUUID(),
      provider: 'openai-codex',
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresIn ? Date.now() + tokenData.expiresIn * 1000 : undefined,
      scope: tokenData.scope,
      email: tokenData.email,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    await storeToken(token);

    return NextResponse.json({
      success: true,
      email: tokenData.email,
      expiresAt: token.expiresAt,
    });
  } catch (error) {
    console.error('OAuth exchange failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to exchange code' },
      { status: 500 }
    );
  }
}
