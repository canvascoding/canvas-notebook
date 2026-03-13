import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PROVIDER_DISPLAY_NAMES,
  saveProviderCredentials,
} from '@/app/lib/pi/oauth';
import { readFile, unlink } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

// Use container data root (/data) or fallback to relative path for local dev
const DATA_ROOT = resolveCanvasDataRoot(process.cwd());
const OAUTH_STATE_DIR = join(DATA_ROOT, 'pi-oauth-states');

/**
 * POST /api/oauth/pi/complete
 * Complete OAuth flow by reading credentials from the completed background process
 * This is used for providers that handle OAuth automatically (e.g., OpenAI, Copilot, Google)
 * Body: { flowId: string, provider: string }
 * Returns: { success: boolean, message?: string, error?: string }
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

    const { flowId, provider } = await request.json();

    if (!flowId) {
      return NextResponse.json(
        { success: false, error: 'Missing flowId' },
        { status: 400 }
      );
    }

    if (!provider || !isOAuthProvider(provider)) {
      return NextResponse.json(
        { success: false, error: `Invalid provider` },
        { status: 400 }
      );
    }

    const stateFile = `${OAUTH_STATE_DIR}/${flowId}.json`;
    const tempScriptDir = `${OAUTH_STATE_DIR}/${flowId}_oauth`;
    const tempAuthPath = `${tempScriptDir}/credentials.json`;

    // Check if flow exists and is completed
    try {
      const stateContent = await readFile(stateFile, 'utf-8');
      const state = JSON.parse(stateContent);

      if (state.status === 'failed') {
        return NextResponse.json({
          success: false,
          error: state.error || 'OAuth flow failed',
        }, { status: 500 });
      }

      if (state.status !== 'completed') {
        return NextResponse.json({
          success: false,
          error: 'OAuth flow not yet completed. Please wait and try again.',
        }, { status: 202 }); // 202 Accepted - still processing
      }

      // Flow completed, read credentials
      try {
        const credsContent = await readFile(tempAuthPath, 'utf-8');
        const credentials = JSON.parse(credsContent);
        
        // Save credentials to auth file
        saveProviderCredentials(provider, credentials);
        
        // Cleanup temp files
        await unlink(tempAuthPath).catch(() => {});
        await unlink(stateFile).catch(() => {});
        
        return NextResponse.json({
          success: true,
          message: `Successfully connected to ${PROVIDER_DISPLAY_NAMES[provider]}`,
        });
      } catch (error) {
        console.error('Failed to read credentials:', error);
        return NextResponse.json({
          success: false,
          error: 'Failed to read credentials from completed OAuth flow',
        }, { status: 500 });
      }
    } catch {
      return NextResponse.json(
        { success: false, error: 'OAuth flow not found or expired' },
        { status: 404 }
      );
    }
  } catch (error) {
    console.error('OAuth complete failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to complete OAuth' },
      { status: 500 }
    );
  }
}
