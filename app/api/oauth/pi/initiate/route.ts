import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
} from '@/app/lib/pi/oauth';
import { spawn } from 'child_process';
import { writeFile, mkdir, readFile, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

// Use container data root (/data) or fallback to relative path for local dev
const DATA_ROOT = resolveCanvasDataRoot();
const AUTH_FILE_PATH = process.env.OAUTH_STORAGE_PATH || join(DATA_ROOT, 'canvas-agent', 'auth.json');
const OAUTH_STATE_DIR = join(DATA_ROOT, 'pi-oauth-states');

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
    const tempScriptDir = `${OAUTH_STATE_DIR}/${flowId}_oauth`;
    const tempScriptPath = `${tempScriptDir}/oauth.mjs`;
    const tempAuthPath = `${tempScriptDir}/credentials.json`;

    // Ensure script directory exists
    await mkdir(tempScriptDir, { recursive: true });

    // Create symlink to node_modules so ES modules can resolve @mariozechner/pi-ai
    const nodeModulesPath = join(process.cwd(), 'node_modules');
    const tempNodeModulesPath = join(tempScriptDir, 'node_modules');
    if (!existsSync(tempNodeModulesPath)) {
      try {
        await symlink(nodeModulesPath, tempNodeModulesPath, 'dir');
      } catch (e) {
        // Symlink might already exist or permission issue, continue anyway
        console.warn(`[OAuth ${flowId}] Could not create node_modules symlink:`, e);
      }
    }

    // Create package.json for the temp script to resolve modules
    const tempPackageJson = JSON.stringify({
      name: `pi-oauth-${flowId}`,
      type: 'module',
      dependencies: {
        '@mariozechner/pi-ai': '*'
      }
    }, null, 2);
    await writeFile(`${tempScriptDir}/package.json`, tempPackageJson);
    await writeFile(stateFile, JSON.stringify({
      flowId,
      provider,
      status: 'pending',
      createdAt: Date.now(),
    }));

    // Create the Node.js script that will run the PI OAuth flow
    const scriptContent = generateOAuthScript(provider, flowId, stateFile, tempAuthPath);
    await writeFile(tempScriptPath, scriptContent);

    // Spawn the OAuth process in the temp script directory (where node_modules symlink exists).
    // Put the VM flag in NODE_OPTIONS so Turbopack does not trace it as a script path.
    const child = spawn(process.execPath, [tempScriptPath], {
      env: { 
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--experimental-vm-modules'].filter(Boolean).join(' '),
        // No NODE_PATH needed - ES modules resolve via node_modules symlink in cwd
      },
      cwd: tempScriptDir,
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
    } catch {
      // State file might not be ready yet
    }
    
    return NextResponse.json({
      success: true,
      flowId,
      provider,
      displayName: PROVIDER_DISPLAY_NAMES[provider],
      authUrl,
      instructions,
      message: authUrl 
        ? 'Please open the URL in your browser, then paste the authorization code or callback URL below'
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
 * Providers with callback servers also get explicit manual callback input so Docker/container
 * deployments do not stall waiting for an unreachable localhost callback.
 */
function generateOAuthScript(provider: string, flowId: string, stateFile: string, tempAuthPath: string): string {
  const loginFn = getLoginFunctionName(provider);
  
  // Different providers have different signatures:
  // - anthropic: loginAnthropic(onAuthUrl, onPromptCode)
  // - openai-codex: loginOpenAICodex({ onAuth, onPrompt, onProgress })
  // - github-copilot: loginGitHubCopilot({ onAuth, onPrompt, onProgress })
  // - google-gemini-cli: loginGeminiCli(onAuth, onProgress?, onManualCodeInput?)
  // - google-antigravity: loginAntigravity(onAuth, onProgress?, onManualCodeInput?)
  const isOptionsBased = ['openai-codex', 'github-copilot'].includes(provider);
  const isSimpleCallback = provider === 'anthropic';
  const usesManualCodeInputOption = provider === 'openai-codex';
  
  return `
import fs from 'fs';
import { ${loginFn} } from '@mariozechner/pi-ai/oauth';

// Helper to update state
function updateState(updates) {
  try {
    const state = JSON.parse(fs.readFileSync('${stateFile}', 'utf-8'));
    Object.assign(state, updates);
    fs.writeFileSync('${stateFile}', JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to update state:', err.message);
  }
}

// Helper to extract code from URL or return code directly
function extractCode(input) {
  if (!input) return input;
  
  // Check if input looks like a URL
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      const url = new URL(input);
      const code = url.searchParams.get('code');
      if (code) {
        console.log('CODE_EXTRACTED_FROM_URL');
        return code;
      }
    } catch (err) {
      // Not a valid URL, return as-is
    }
  }
  
  // Return input as-is (could be code#state format for Anthropic)
  return input;
}

async function run() {
  try {
    // Update state to waiting for auth
    updateState({ status: 'waiting_for_auth', startedAt: Date.now() });

    // Common callback functions
    const handleAuthUrl = (url, instructions) => {
      console.log('AUTH_URL:', url);
      if (instructions) console.log('INSTRUCTIONS:', instructions);
      
      updateState({ 
        status: 'auth_url_received', 
        authUrl: url, 
        instructions: instructions || '',
        updatedAt: Date.now()
      });
    };

    const handlePromptCode = async () => {
      console.log('WAITING_FOR_CODE');
      updateState({ status: 'waiting_for_code', updatedAt: Date.now() });
      
      // Wait for the code file to be created by the exchange endpoint
      const codeFile = '${stateFile}'.replace('.json', '_code.txt');
      const maxWait = 10 * 60 * 1000; // 10 minutes
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWait) {
        try {
          if (fs.existsSync(codeFile)) {
            const rawInput = fs.readFileSync(codeFile, 'utf-8').trim();
            fs.unlinkSync(codeFile); // Clean up
            
            // Extract code from URL if needed
            const code = extractCode(rawInput);
            console.log('CODE_RECEIVED');
            return code;
          }
        } catch {
          // File doesn't exist yet
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      
      throw new Error('Timeout waiting for authorization code');
    };

    const handleProgress = (message) => {
      console.log('PROGRESS:', message);
    };

    let credentials;
    ${isSimpleCallback ? `
    // ${provider} uses simple callback signature
    credentials = await ${loginFn}(handleAuthUrl, handlePromptCode);
    ` : isOptionsBased ? `
    // ${provider} uses options object
    credentials = await ${loginFn}({
      onAuth: (info) => {
        const url = typeof info === 'string' ? info : info.url;
        const instructions = typeof info === 'string' ? undefined : info.instructions;
        handleAuthUrl(url, instructions);
      },
      onPrompt: handlePromptCode,
      ${usesManualCodeInputOption ? 'onManualCodeInput: handlePromptCode,' : ''}
      onProgress: handleProgress
    });
    ` : `
    // ${provider} uses callback signature
    credentials = await ${loginFn}(
      (info) => {
        const url = typeof info === 'string' ? info : info.url;
        const instructions = typeof info === 'string' ? undefined : info.instructions;
        handleAuthUrl(url, instructions);
      },
      handleProgress,
      handlePromptCode
    );
    `}

    // Save credentials
    fs.writeFileSync('${tempAuthPath}', JSON.stringify(credentials, null, 2));
    updateState({ 
      status: 'completed', 
      completedAt: Date.now(),
      hasCredentials: true 
    });
    
    // Wait for filesystem sync before exiting
    await new Promise(r => setTimeout(r, 500));
    
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
