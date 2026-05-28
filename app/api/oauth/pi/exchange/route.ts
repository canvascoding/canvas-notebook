import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  saveProviderCredentials,
} from '@/app/lib/pi/oauth';
import { readFile, writeFile, access, unlink } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

// Use container data root (/data) or fallback to relative path for local dev
const DATA_ROOT = resolveCanvasDataRoot(process.cwd());
const OAUTH_STATE_DIR = join(DATA_ROOT, 'pi-oauth-states');

function normalizeOAuthFlowId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null;
}

/**
 * POST /api/oauth/pi/exchange
 * Exchange authorization code for OAuth credentials
 * Body: { flowId: string, provider: string, code: string }
 * Returns: { success: boolean, pending?: boolean, message?: string, error?: string }
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

    const { flowId: rawFlowId, provider, code } = await request.json();
    const flowId = normalizeOAuthFlowId(rawFlowId);

    if (!flowId) {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid flowId' },
        { status: 400 }
      );
    }

    if (!provider || !isOAuthProvider(provider)) {
      return NextResponse.json(
        { success: false, error: `Invalid provider. Supported: ${PI_OAUTH_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    if (!code) {
      return NextResponse.json(
        { success: false, error: 'Missing code' },
        { status: 400 }
      );
    }

    const stateFile = join(OAUTH_STATE_DIR, `${flowId}.json`);
    const codeFile = join(OAUTH_STATE_DIR, `${flowId}_code.txt`);
    // Credentials are saved in the temp script directory by the background process
    const tempAuthPath = join(OAUTH_STATE_DIR, `${flowId}_oauth`, 'credentials.json');

    // Check if flow exists
    try {
      await access(stateFile, constants.F_OK);
    } catch {
      return NextResponse.json(
        { success: false, error: 'OAuth flow not found or expired' },
        { status: 404 }
      );
    }

    // Read current state
    const stateContent = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(stateContent);

    if (state.status === 'completed') {
      // Flow already completed, try to save credentials
      try {
        const credsContent = await readFile(tempAuthPath, 'utf-8');
        const credentials = JSON.parse(credsContent);
        saveProviderCredentials(provider, credentials);
        
        // Cleanup
        await unlink(tempAuthPath).catch(() => {});
        await unlink(stateFile).catch(() => {});
        
        return NextResponse.json({
          success: true,
          message: `Successfully connected to ${PROVIDER_DISPLAY_NAMES[provider]}`,
        });
      } catch {
        return NextResponse.json({
          success: false,
          error: 'Failed to read credentials',
        }, { status: 500 });
      }
    }

    if (state.status === 'failed') {
      return NextResponse.json({
        success: false,
        error: state.error || 'OAuth flow failed',
      }, { status: 500 });
    }

    // Write the code so the background process can read it
    await writeFile(codeFile, code);

    // Wait for the background process to complete
    const maxWait = 5000; // Keep request short; UI continues via poll/complete
    const startTime = Date.now();
    
    // Check immediately first (in case process was already waiting)
    await new Promise(resolve => setTimeout(resolve, 100));
    
    while (Date.now() - startTime < maxWait) {
      try {
        const currentStateContent = await readFile(stateFile, 'utf-8');
        const currentState = JSON.parse(currentStateContent);
        
        if (currentState.status === 'completed') {
          // Credentials saved, read and store them
          const credsContent = await readFile(tempAuthPath, 'utf-8');
          const credentials = JSON.parse(credsContent);
          saveProviderCredentials(provider, credentials);
          
          // Cleanup
          await unlink(tempAuthPath).catch(() => {});
          await unlink(stateFile).catch(() => {});
          
          return NextResponse.json({
            success: true,
            message: `Successfully connected to ${PROVIDER_DISPLAY_NAMES[provider]}`,
          });
        }
        
        if (currentState.status === 'failed') {
          await unlink(stateFile).catch(() => {});
          return NextResponse.json({
            success: false,
            error: currentState.error || 'OAuth flow failed',
          }, { status: 500 });
        }
      } catch {
        // Continue waiting
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return NextResponse.json({
      success: true,
      pending: true,
      message: 'Authorization code received. Waiting for provider completion...',
    }, { status: 202 });
  } catch (error) {
    console.error('OAuth exchange failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to exchange code' },
      { status: 500 }
    );
  }
}
