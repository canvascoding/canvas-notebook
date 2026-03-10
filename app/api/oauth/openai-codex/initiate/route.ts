import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { generatePKCE, storeOAuthState } from '@/app/lib/oauth/codex';

/**
 * POST /api/oauth/openai-codex/initiate
 * Start OAuth flow for OpenAI Codex
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

    // Generate PKCE
    const pkce = generatePKCE();
    
    // Store state
    const state = await storeOAuthState(session.user.id, pkce);

    // Build auth URL
    const clientId = process.env.OPENAI_CODEX_CLIENT_ID || 'openai-codex-cli';
    const redirectUri = process.env.OPENAI_CODEX_REDIRECT_URI || 'http://localhost:3000/callback';
    const scope = 'codex';
    
    const authUrl = new URL('https://auth.openai.com/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return NextResponse.json({
      success: true,
      authUrl: authUrl.toString(),
      state,
    });
  } catch (error) {
    console.error('OAuth initiate failed:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to initiate OAuth' },
      { status: 500 }
    );
  }
}
