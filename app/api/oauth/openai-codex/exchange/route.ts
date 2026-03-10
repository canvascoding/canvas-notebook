import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import crypto from 'crypto';

/**
 * POST /api/oauth/openai-codex/exchange
 * Exchange callback URL for token by extracting code and calling OpenAI API
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
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid callback URL format' },
        { status: 400 }
      );
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    
    if (error) {
      return NextResponse.json(
        { success: false, error: `OAuth error: ${error}` },
        { status: 400 }
      );
    }
    
    if (!code) {
      return NextResponse.json(
        { success: false, error: 'Missing authorization code in callback URL' },
        { status: 400 }
      );
    }

    // Exchange code for token with OpenAI
    const tokenResult = await exchangeCodeForToken(code);

    if (!tokenResult.success || !tokenResult.accessToken) {
      return NextResponse.json(
        { success: false, error: tokenResult.error || 'Failed to exchange code for token' },
        { status: 500 }
      );
    }

    // Get user info from OpenAI
    const userInfo = await getOpenAIUserInfo(tokenResult.accessToken);

    // Store token in our database
    const { storeToken } = await import('@/app/lib/oauth/store');
    await storeToken({
      id: crypto.randomUUID(),
      provider: 'openai-codex',
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken,
      expiresAt: tokenResult.expiresAt,
      scope: tokenResult.scope,
      email: userInfo.email,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return NextResponse.json({
      success: true,
      email: userInfo.email,
      message: 'Successfully connected OpenAI account',
    });
  } catch (error) {
    console.error('OAuth exchange failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to exchange code' },
      { status: 500 }
    );
  }
}

async function exchangeCodeForToken(code: string): Promise<{
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  error?: string;
}> {
  try {
    const clientId = process.env.OPENAI_CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
    const clientSecret = process.env.OPENAI_CODEX_CLIENT_SECRET || '';
    const redirectUri = process.env.OPENAI_CODEX_REDIRECT_URI || 'http://localhost:3000/callback';
    
    const tokenUrl = 'https://auth.openai.com/token';
    
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${errorText}`);
    }
    
    const data = await response.json();
    
    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
    };
  } catch (error) {
    console.error('Token exchange error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token exchange failed',
    };
  }
}

async function getOpenAIUserInfo(accessToken: string): Promise<{ email?: string }> {
  try {
    const response = await fetch('https://api.openai.com/v1/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    if (!response.ok) {
      return { email: undefined };
    }
    
    const data = await response.json();
    return { email: data.email };
  } catch (error) {
    console.error('Failed to get user info:', error);
    return { email: undefined };
  }
}
