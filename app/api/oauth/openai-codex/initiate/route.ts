import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

/**
 * POST /api/oauth/openai-codex/initiate
 * Start OAuth flow using Codex CLI
 * Returns the auth URL that the user must open in their browser
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

    // Start codex login to get the auth URL
    const result = await getCodexAuthUrl();

    if (!result.success || !result.authUrl) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to get auth URL from Codex CLI' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      authUrl: result.authUrl,
      message: 'Open this URL in your browser to authenticate. After successful login, the token will be stored locally and you can click "Verify Connection".',
    });
  } catch (error) {
    console.error('OAuth initiate failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to initiate OAuth' },
      { status: 500 }
    );
  }
}

async function getCodexAuthUrl(): Promise<{ success: boolean; authUrl?: string; error?: string }> {
  try {
    // Run codex login - it will output the auth URL
    const { stdout, stderr } = await execAsync('codex login', {
      timeout: 5000,
      env: {
        ...process.env,
      },
    });

    const output = stdout + stderr;
    console.log('Codex login output:', output);

    // Extract auth URL from output
    // Codex CLI outputs something like:
    // "Please visit: https://auth.openai.com/oauth/authorize?..."
    const patterns = [
      /please\s+visit[:\s]+(https:\/\/auth\.openai\.com\/[^\s]+)/i,
      /visit[:\s]+(https:\/\/auth\.openai\.com\/[^\s]+)/i,
      /url[:\s]+(https:\/\/auth\.openai\.com\/[^\s]+)/i,
      /(https:\/\/auth\.openai\.com\/oauth\/authorize[^\s]+)/,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return { success: true, authUrl: match[1] };
      }
    }

    // Check if already authenticated
    if (output.includes('already') || output.includes('authenticated')) {
      return { success: true, authUrl: '', error: 'Already authenticated' };
    }

    return { success: false, error: 'Could not find auth URL in output: ' + output };
  } catch (error) {
    console.error('Error running codex login:', error);
    
    // Check if timed out (which is expected since codex waits for auth)
    if (error instanceof Error && error.message.includes('timed out')) {
      // Extract URL from the error message or stdout
      const errorStr = String(error);
      const match = errorStr.match(/(https:\/\/auth\.openai\.com\/[^\s]+)/);
      if (match) {
        return { success: true, authUrl: match[1] };
      }
    }
    
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to run codex login' 
    };
  }
}
