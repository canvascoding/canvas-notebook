import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { spawn } from 'child_process';

/**
 * POST /api/oauth/openai-codex/exchange
 * Pass callback URL to Codex CLI to complete authentication
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

    // Parse callback URL to extract code and state
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

    // Complete the OAuth flow by passing the code to Codex CLI
    // Codex CLI will exchange the code for a token and store it locally
    const result = await completeCodexLogin(code, state || '');

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to complete login' },
        { status: 500 }
      );
    }

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

async function completeCodexLogin(code: string, state: string): Promise<{ success: boolean; email?: string; error?: string }> {
  return new Promise((resolve) => {
    // Spawn codex login process
    // We'll simulate the callback by passing the code via environment variables
    // or by making a request to the local callback server if running
    const env = {
      ...process.env,
      CODEX_OAUTH_CODE: code,
      CODEX_OAUTH_STATE: state,
    };

    // Try to complete the login by spawning codex with the code
    // Codex CLI might accept the code via stdin or environment
    const codex = spawn('codex', ['login', '--code', code], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    codex.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    codex.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    codex.on('close', (code) => {
      console.log('Codex login stdout:', stdout);
      console.log('Codex login stderr:', stderr);
      console.log('Codex login exit code:', code);

      // Check if successful
      if (code === 0 || stdout.includes('success') || stdout.includes('authenticated')) {
        // Try to extract email from output
        const emailMatch = stdout.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
        resolve({
          success: true,
          email: emailMatch ? emailMatch[1] : undefined,
        });
      } else if (stderr.includes('already') || stderr.includes('authenticated')) {
        resolve({
          success: true,
          email: undefined,
        });
      } else {
        resolve({
          success: false,
          error: stderr || 'Codex login failed',
        });
      }
    });

    codex.on('error', (error) => {
      console.error('Failed to spawn codex:', error);
      resolve({
        success: false,
        error: error.message,
      });
    });

    // Send code via stdin as alternative method
    codex.stdin.write(`${code}\n`);
    codex.stdin.end();

    // Timeout after 30 seconds
    setTimeout(() => {
      codex.kill();
      resolve({
        success: false,
        error: 'Codex login timed out',
      });
    }, 30000);
  });
}
