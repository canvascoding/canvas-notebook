import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { codexCallbackPorts } from '../initiate/route';

/**
 * POST /api/oauth/openai-codex/exchange
 * Send callback URL to Codex CLI's local server to complete authentication
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

    // Parse the callback URL
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

    // Extract the port from the callback URL
    // Format: http://localhost:PORT/auth/callback
    const portMatch = callbackUrl.match(/localhost:(\d+)/);
    let port: number;
    
    if (portMatch) {
      port = parseInt(portMatch[1], 10);
    } else {
      // Fallback: try to get from stored ports
      port = codexCallbackPorts.get(session.user.id) || 1455;
    }

    console.log('Sending callback to Codex CLI on port:', port);
    console.log('Code:', code);
    console.log('State:', state);

    // Send the callback to Codex CLI's local server
    const result = await sendToCodexCallbackServer(port, code, state || '');

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to complete login' },
        { status: 500 }
      );
    }

    // Clean up stored port
    codexCallbackPorts.delete(session.user.id);

    return NextResponse.json({
      success: true,
      email: result.email,
      message: 'Successfully connected OpenAI account via Codex CLI',
    });
  } catch (error) {
    console.error('OAuth exchange failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to exchange code' },
      { status: 500 }
    );
  }
}

async function sendToCodexCallbackServer(
  port: number, 
  code: string, 
  state: string
): Promise<{ success: boolean; email?: string; error?: string }> {
  try {
    // Construct the callback URL for Codex CLI
    // Format: http://localhost:PORT/auth/callback?code=...&state=...
    const callbackPath = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    const callbackUrl = `http://localhost:${port}${callbackPath}`;

    console.log('Sending request to:', callbackUrl);

    // Send GET request to Codex CLI's callback endpoint
    const response = await fetch(callbackUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
      },
    });

    console.log('Codex callback response status:', response.status);
    const responseText = await response.text();
    console.log('Codex callback response:', responseText.substring(0, 500));

    if (response.ok || response.status === 302 || response.status === 301) {
      // Success! Codex CLI should now be authenticated
      return { success: true };
    } else {
      return { 
        success: false, 
        error: `Codex CLI returned status ${response.status}: ${responseText.substring(0, 200)}` 
      };
    }
  } catch (error) {
    console.error('Error sending to Codex callback server:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send callback to Codex CLI' 
    };
  }
}
