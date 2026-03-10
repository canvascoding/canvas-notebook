import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  saveProviderCredentials,
} from '@/app/lib/pi/oauth';
import { spawn } from 'child_process';
import { writeFile, mkdir, unlink, readFile } from 'fs/promises';
import { dirname } from 'path';

const AUTH_FILE_PATH = '/data/canvas-agent/auth.json';

/**
 * POST /api/oauth/pi/exchange
 * Exchange authorization code or callback URL for OAuth credentials
 * Uses npx @mariozechner/pi-ai login to complete the flow
 * Body: { provider: string, code?: string, callbackUrl?: string }
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

    const { provider, code, callbackUrl } = await request.json();

    if (!provider || !isOAuthProvider(provider)) {
      return NextResponse.json(
        { success: false, error: `Invalid provider. Supported: ${PI_OAUTH_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    if (!code && !callbackUrl) {
      return NextResponse.json(
        { success: false, error: 'Missing code or callbackUrl' },
        { status: 400 }
      );
    }

    // Ensure auth directory exists
    await mkdir(dirname(AUTH_FILE_PATH), { recursive: true });

    // For now, we'll use a simplified approach
    // In production, this would run the actual PI login with the code
    
    // Write the code to a temp file that the CLI can read
    // This is a workaround since PI CLI doesn't support direct code input via CLI args
    
    // Create a simple Node.js script that uses the PI library
    const tempScriptPath = `/tmp/pi-oauth-${provider}-${Date.now()}.js`;
    const tempAuthPath = `/tmp/pi-auth-${provider}-${Date.now()}.json`;
    
    const scriptContent = `
const { ${getLoginFunctionName(provider)} } = require('@mariozechner/pi-ai/oauth');
const fs = require('fs');

async function run() {
  try {
    // Create a mock implementation that uses the code
    const credentials = await ${getLoginFunctionName(provider)}(
      (url, instructions) => {
        console.log('AUTH_URL:', url);
        if (instructions) console.log('INSTRUCTIONS:', instructions);
      },
      async () => {
        // Return the code from the request
        return '${code || ''}';
      },
      (message) => {
        console.log('PROGRESS:', message);
      }
    );
    
    // Save credentials
    fs.writeFileSync('${tempAuthPath}', JSON.stringify(credentials, null, 2));
    console.log('SUCCESS: Credentials saved');
  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }
}

run();
`;

    await writeFile(tempScriptPath, scriptContent);

    // Run the script
    const result = await new Promise<NextResponse>((resolve) => {
      const child = spawn('node', [tempScriptPath], {
        env: {
          ...process.env,
          NODE_PATH: '/Users/frankalexanderweber/.openclaw/workspace-mango-jerry/canvasstudios-notebook/node_modules',
        },
        timeout: 60000,
      });

      let stderr = '';

      child.stdout?.on('data', (data) => {
        console.log(`[OAuth ${provider}] stdout:`, data.toString());
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
        console.error(`[OAuth ${provider}] stderr:`, data.toString());
      });

      child.on('close', async (exitCode) => {
        try {
          // Clean up temp script
          await unlink(tempScriptPath).catch(() => {});

          if (exitCode !== 0) {
            resolve(NextResponse.json(
              { success: false, error: `OAuth flow failed: ${stderr || 'Unknown error'}` },
              { status: 500 }
            ));
            return;
          }

          // Try to read the credentials
          try {
            const credsContent = await readFile(tempAuthPath, 'utf-8');
            const credentials = JSON.parse(credsContent);
            
            // Save to our auth file
            saveProviderCredentials(provider, credentials);
            
            // Clean up temp auth file
            await unlink(tempAuthPath).catch(() => {});

            resolve(NextResponse.json({
              success: true,
              message: `Successfully connected to ${PROVIDER_DISPLAY_NAMES[provider]}`,
            }));
          } catch {
            resolve(NextResponse.json(
              { success: false, error: 'Failed to read credentials' },
              { status: 500 }
            ));
          }
        } catch {
          resolve(NextResponse.json({
            success: true,
            message: `OAuth flow completed for ${PROVIDER_DISPLAY_NAMES[provider]}`,
            warning: 'Cleanup failed but credentials may be saved',
          }));
        }
      });

      child.on('error', (error) => {
        console.error(`[OAuth ${provider}] Error:`, error);
        resolve(NextResponse.json(
          { success: false, error: `Failed to run OAuth flow: ${error.message}` },
          { status: 500 }
        ));
      });
    });
    
    return result;
  } catch (error) {
    console.error('OAuth exchange failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to exchange code' },
      { status: 500 }
    );
  }
}

function getLoginFunctionName(provider: string): string {
  const map: Record<string, string> = {
    'anthropic': 'loginAnthropic',
    'openai-codex': 'loginOpenAICodex',
    'github-copilot': 'loginGitHubCopilot',
    'google-gemini-cli': 'loginGeminiCli',
    'google-antigravity': 'loginAntigravity',
  };
  return map[provider] || 'loginAnthropic';
}
