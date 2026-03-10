import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
} from '@/app/lib/pi/oauth';
import { spawn } from 'child_process';
import { writeFile, mkdir, readFile, unlink, access } from 'fs/promises';
import { dirname } from 'path';

// Use relative path for local dev, /data for container
const AUTH_FILE_PATH = process.env.OAUTH_STORAGE_PATH || './data/canvas-agent/auth.json';
const OAUTH_STATE_DIR = '/tmp/pi-oauth-states';

/**
 * POST /api/oauth/pi/initiate
 * Start OAuth flow for a PI provider
 * Creates a background process that runs the PI login and captures the auth URL
 * Returns immediately with a flowId for polling
 * Body: { provider: string }
 * Returns: { success: boolean, flowId: string, authUrl?: string, message?: string }
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

    // Ensure auth directory exists
    await mkdir(dirname(AUTH_FILE_PATH), { recursive: true });
    await mkdir(OAUTH_STATE_DIR, { recursive: true });

    // Create unique flow ID
    const flowId = `flow_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const stateFile = `${OAUTH_STATE_DIR}/${flowId}.json`;
    const tempScriptPath = `${OAUTH_STATE_DIR}/${flowId}.js`;
    const tempAuthPath = `${OAUTH_STATE_DIR}/${flowId}_credentials.json`;

    // Initial state: pending
    await writeFile(stateFile, JSON.stringify({
      flowId,
      provider,
      status: 'pending',
      createdAt: Date.now(),
    }));

    // Create the Node.js script that will run the PI OAuth flow
    const scriptContent = generateOAuthScript(provider, flowId, stateFile, tempAuthPath);
    await writeFile(tempScriptPath, scriptContent);

    // Spawn the OAuth process in the background with correct working directory
    const child = spawn('node', [tempScriptPath], {
      env: { 
        ...process.env,
        NODE_PATH: `${process.cwd()}/node_modules`,
      },
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Handle stdout/stderr for logging
    child.stdout?.on('data', (data) => {
      console.log(`[OAuth ${flowId}] ${data.toString().trim()}`);
    });
    child.stderr?.on('data', (data) => {
      console.error(`[OAuth ${flowId}] ${data.toString().trim()}`);
    });

    // Unref so parent can exit
    child.unref();

    // Wait a moment for the auth URL to be written
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Read the state file to get the auth URL
    let authUrl = '';
    let instructions = '';
    try {
      const stateContent = await readFile(stateFile, 'utf-8');
      const state = JSON.parse(stateContent);
      authUrl = state.authUrl || '';
      instructions = state.instructions || '';
    } catch (e) {
      // State file might not be ready yet
    }

    return NextResponse.json({
      success: true,
      flowId,
      provider,
      displayName: PROVIDER_DISPLAY_NAMES[provider],
      authUrl,
      instructions,
      requiresCode: !authUrl.includes('callback'), // Some flows need manual code entry
      message: authUrl 
        ? 'Please open the URL in your browser to complete authentication'
        : 'Waiting for OAuth flow to start...',
    });
  } catch (error) {
    console.error('OAuth initiate failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to initiate OAuth' },
      { status: 500 }
    );
  }
}

/**
 * Generate the OAuth script that runs in a background process
 */
function generateOAuthScript(provider: string, flowId: string, stateFile: string, tempAuthPath: string): string {
  const loginFn = getLoginFunctionName(provider);
  
  return `
const fs = require('fs');
const path = require('path');

// Helper to update state
function updateState(updates) {
  try {
    const state = JSON.parse(fs.readFileSync('${stateFile}', 'utf-8'));
    Object.assign(state, updates);
    fs.writeFileSync('${stateFile}', JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to update state:', e.message);
  }
}

async function run() {
  try {
    // Set up module path for the PI library
    const projectRoot = '${process.cwd().replace(/'/g, "'\\''")}';
    const nodeModulesPath = projectRoot + '/node_modules';
    module.paths.unshift(nodeModulesPath);
    require.main.paths.unshift(nodeModulesPath);
    
    const { ${loginFn} } = require('@mariozechner/pi-ai/oauth');
    
    // Update state to waiting for auth
    updateState({ status: 'waiting_for_auth', startedAt: Date.now() });

    let authUrlReceived = false;

    const credentials = await ${loginFn}(
      // onAuth callback - called with auth URL
      (url, instructions) => {
        console.log('AUTH_URL:', url);
        if (instructions) console.log('INSTRUCTIONS:', instructions);
        
        updateState({ 
          status: 'auth_url_received', 
          authUrl: url, 
          instructions: instructions || '',
          updatedAt: Date.now()
        });
        authUrlReceived = true;
      },
      // onPrompt callback - called when code is needed
      async () => {
        console.log('WAITING_FOR_CODE');
        updateState({ status: 'waiting_for_code', updatedAt: Date.now() });
        
        // Wait for the code file to be created by the exchange endpoint
        const codeFile = '${stateFile}'.replace('.json', '_code.txt');
        const maxWait = 10 * 60 * 1000; // 10 minutes
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWait) {
          try {
            if (fs.existsSync(codeFile)) {
              const code = fs.readFileSync(codeFile, 'utf-8').trim();
              fs.unlinkSync(codeFile); // Clean up
              console.log('CODE_RECEIVED');
              return code;
            }
          } catch (e) {
            // File doesn't exist yet
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        
        throw new Error('Timeout waiting for authorization code');
      },
      // onProgress callback
      (message) => {
        console.log('PROGRESS:', message);
      }
    );

    // Save credentials
    fs.writeFileSync('${tempAuthPath}', JSON.stringify(credentials, null, 2));
    updateState({ 
      status: 'completed', 
      completedAt: Date.now(),
      hasCredentials: true 
    });
    
    console.log('SUCCESS: OAuth completed');
    process.exit(0);
  } catch (error) {
    console.error('ERROR:', error.message);
    updateState({ 
      status: 'failed', 
      error: error.message,
      failedAt: Date.now()
    });
    process.exit(1);
  }
}

run();
`;
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
