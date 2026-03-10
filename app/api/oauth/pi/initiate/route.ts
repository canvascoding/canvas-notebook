import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
} from '@/app/lib/pi/oauth';
import { spawn } from 'child_process';

/**
 * POST /api/oauth/pi/initiate
 * Start OAuth flow for a PI provider
 * Runs npx @mariozechner/pi-ai login <provider> and captures the auth URL
 * Body: { provider: string }
 * Returns: { 
 *   success: boolean, 
 *   provider: string,
 *   authUrl?: string, 
 *   instructions?: string,
 *   requiresCode: boolean,
 *   message?: string, 
 *   error?: string 
 * }
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

    // For now, return provider-specific OAuth URLs
    // In a full implementation, we would run the CLI and capture the URL
    const providerUrls: Record<string, { url: string; requiresCode: boolean; instructions?: string }> = {
      'anthropic': {
        url: 'https://console.anthropic.com/settings/keys',
        requiresCode: true,
        instructions: '1. Open the link above\n2. Create a new API key\n3. Copy and paste the key below',
      },
      'openai-codex': {
        url: 'https://auth.openai.com/oauth/authorize',
        requiresCode: true,
        instructions: '1. Click the link above\n2. Login with your OpenAI account (requires ChatGPT Plus/Pro)\n3. Complete the authorization\n4. Copy the authorization code or callback URL\n5. Paste it below',
      },
      'github-copilot': {
        url: 'https://github.com/login/oauth/authorize',
        requiresCode: true,
        instructions: '1. Click the link above\n2. Authorize GitHub Copilot access\n3. Copy the authorization code\n4. Paste it below',
      },
      'google-gemini-cli': {
        url: 'https://accounts.google.com/o/oauth2/auth',
        requiresCode: true,
        instructions: '1. Click the link above\n2. Login with your Google account\n3. Allow Google Cloud Code Assist access\n4. Copy the authorization code\n5. Paste it below',
      },
      'google-antigravity': {
        url: 'https://accounts.google.com/o/oauth2/auth',
        requiresCode: true,
        instructions: '1. Click the link above\n2. Login with your Google account\n3. Allow Antigravity access\n4. Copy the authorization code\n5. Paste it below',
      },
    };

    const providerInfo = providerUrls[provider];
    
    if (!providerInfo) {
      return NextResponse.json(
        { success: false, error: `Provider ${provider} not configured` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      provider,
      displayName: PROVIDER_DISPLAY_NAMES[provider],
      authUrl: providerInfo.url,
      requiresCode: providerInfo.requiresCode,
      instructions: providerInfo.instructions,
      message: `Please open the URL and complete authentication for ${PROVIDER_DISPLAY_NAMES[provider]}`,
    });
  } catch (error) {
    console.error('OAuth initiate failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to initiate OAuth' },
      { status: 500 }
    );
  }
}
