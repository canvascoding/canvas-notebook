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

    // Build auth URL - matching official Codex CLI format
    const clientId = process.env.OPENAI_CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
    const redirectUri = process.env.OPENAI_CODEX_REDIRECT_URI || 'http://localhost:3000/callback';
    const scope = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
    
    const authUrl = new URL('https://auth.openai.com/oauth/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('originator', 'codex_cli_rs');

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
