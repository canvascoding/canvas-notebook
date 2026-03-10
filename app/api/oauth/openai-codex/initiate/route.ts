import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Store the codex callback port temporarily
// In production, this should be in a proper session store or database
const codexCallbackPorts = new Map<string, number>();

/**
 * POST /api/oauth/openai-codex/initiate
 * Start OAuth flow using Codex CLI
 * Captures and stores the dynamic callback port
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

    // Start codex login and capture the auth URL with port
    const result = await getCodexAuthUrl(session.user.id);

    if (!result.success || !result.authUrl) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to get auth URL from Codex CLI' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      authUrl: result.authUrl,
      message: 'Open this URL in your browser to authenticate. After successful login, paste the callback URL back here.',
    });
  } catch (error) {
    console.error('OAuth initiate failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to initiate OAuth' },
      { status: 500 }
    );
  }
}

async function getCodexAuthUrl(userId: string): Promise<{ success: boolean; authUrl?: string; error?: string }> {
  try {
    // Run codex login in background - it will start a server and output the URL
    const codexProcess = exec('codex login', {
      env: {
        ...process.env,
      },
    });

    let output = '';
    let authUrl: string | null = null;
    let callbackPort: number | null = null;

    // Collect output
    codexProcess.stdout?.on('data', (data) => {
      output += data.toString();
      console.log('Codex stdout:', data.toString());
    });

    codexProcess.stderr?.on('data', (data) => {
      output += data.toString();
      console.log('Codex stderr:', data.toString());
    });

    // Wait for the auth URL to appear (timeout after 10 seconds)
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        // Look for the auth URL in output
        // Pattern: http://localhost:PORT/auth/callback
        const urlMatch = output.match(/(https?:\/\/auth\.openai\.com\/[^\s]+)/);
        if (urlMatch) {
          authUrl = urlMatch[1];
          
          // Extract the callback port from the URL
          // The redirect_uri in the URL contains the port
          const redirectMatch = authUrl.match(/redirect_uri=http[^&]*localhost%3A(\d+)/);
          if (redirectMatch) {
            callbackPort = parseInt(redirectMatch[1], 10);
            console.log('Found Codex callback port:', callbackPort);
            
            // Store the port for this user
            codexCallbackPorts.set(userId, callbackPort);
          }
          
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);

      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Timeout waiting for auth URL'));
      }, 10000);
    });

    if (!authUrl) {
      return { success: false, error: 'Could not extract auth URL from output' };
    }

    return { success: true, authUrl };
  } catch (error) {
    console.error('Error running codex login:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to run codex login' 
    };
  }
}

// Export the ports map for the exchange route
export { codexCallbackPorts };
