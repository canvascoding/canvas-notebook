import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { 
  isOAuthProvider,
  PI_OAUTH_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
} from '@/app/lib/pi/oauth';
import { randomUUID } from 'node:crypto';
import { spawn } from 'child_process';
import { writeFile, mkdir, readFile, readdir, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveScopedPiOAuthStatesDir, type UserScopedDataStorageScope } from '@/app/lib/runtime-data-paths';


const ACTIVE_STATUSES = new Set(['pending', 'waiting_for_auth', 'waiting_for_code', 'auth_url_received']);

async function killStaleFlows(provider: string, stateDir: string, userId: string): Promise<void> {
  if (!existsSync(stateDir)) return;

  const entries = await readdir(stateDir);
  const stateFiles = entries.filter(e => e.endsWith('.json'));

  let killed = 0;
  for (const file of stateFiles) {
    const filePath = join(stateDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      const state = JSON.parse(content);
      if (state.userId !== userId || state.provider !== provider || !ACTIVE_STATUSES.has(state.status)) continue;

      if (state.pid && typeof state.pid === 'number') {
        try {
          process.kill(state.pid, 0);
          process.kill(state.pid, 'SIGTERM');
          console.log(`[oauth/initiate] Killed stale ${provider} flow ${state.flowId} (PID ${state.pid})`);
          killed++;
        } catch {
          // Process already dead, nothing to do
        }
      }

      state.status = 'failed';
      state.error = 'Superseded by new OAuth flow';
      state.failedAt = Date.now();
      await writeFile(filePath, JSON.stringify(state, null, 2));
    } catch {
      // Corrupt state file, skip
    }
  }

  if (killed > 0) {
    await new Promise(r => setTimeout(r, 2000));
  }
}

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
    console.log(`[oauth/initiate] POST: provider=${provider}`);

    if (!provider || !isOAuthProvider(provider)) {
      return NextResponse.json(
        { success: false, error: `Invalid provider. Supported: ${PI_OAUTH_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    const storageScope: UserScopedDataStorageScope = { userId: session.user.id };
    const oauthStateDir = resolveScopedPiOAuthStatesDir(storageScope);
    await mkdir(oauthStateDir, { recursive: true });

    // Kill any stale OAuth flows for the same provider (frees up the callback port)
    await killStaleFlows(provider, oauthStateDir, session.user.id);

    // Create unique flow ID
    const flowId = `flow_${Date.now()}_${randomUUID()}`;
    const stateFile = join(oauthStateDir, `${flowId}.json`);
    const tempScriptDir = join(oauthStateDir, `${flowId}_oauth`);
    const tempScriptPath = join(tempScriptDir, 'oauth.mjs');
    const tempAuthPath = join(tempScriptDir, 'credentials.json');

    // Ensure script directory exists
    await mkdir(tempScriptDir, { recursive: true });

    // Create symlink to node_modules so ES modules can resolve @earendil-works/pi-ai
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
        '@earendil-works/pi-ai': '*'
      }
    }, null, 2);
    await writeFile(join(tempScriptDir, 'package.json'), tempPackageJson);
    await writeFile(stateFile, JSON.stringify({
      flowId,
      provider,
      userId: session.user.id,
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
      },
      cwd: tempScriptDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Store PID in state file for cleanup by killStaleFlows
    try {
      const existing = JSON.parse(await readFile(stateFile, 'utf-8'));
      existing.pid = child.pid;
      await writeFile(stateFile, JSON.stringify(existing, null, 2));
    } catch {
      // Non-critical, continue
    }

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
  const stateFileLiteral = JSON.stringify(stateFile);
  const tempAuthPathLiteral = JSON.stringify(tempAuthPath);
  
  // Different providers have different signatures:
  // - anthropic: loginAnthropic({ onAuth, onPrompt, onProgress, onManualCodeInput })
  // - openai-codex: loginOpenAICodex({ onAuth, onPrompt, onProgress, onManualCodeInput })
  // - github-copilot: loginGitHubCopilot({ onDeviceCode, onPrompt, onProgress })
  // All use options-based API now
  
  return `
import fs from 'fs';
import { ${loginFn} } from '@earendil-works/pi-ai/oauth';

// Helper to update state
function updateState(updates) {
  try {
    const state = JSON.parse(fs.readFileSync(${stateFileLiteral}, 'utf-8'));
    Object.assign(state, updates);
    fs.writeFileSync(${stateFileLiteral}, JSON.stringify(state, null, 2));
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
    const handleAuthUrl = (urlOrInfo, instructions) => {
      const url = typeof urlOrInfo === 'string' ? urlOrInfo : urlOrInfo.url;
      const instr = typeof urlOrInfo === 'string' ? instructions : urlOrInfo.instructions;
      console.log('AUTH_URL:', url);
      if (instr) console.log('INSTRUCTIONS:', instr);
      
      updateState({ 
        status: 'auth_url_received', 
        authUrl: url, 
        instructions: instr || '',
        updatedAt: Date.now()
      });
    };

    const handleDeviceCode = (info) => {
      const instructions = [
        'Enter code: ' + info.userCode,
        info.expiresInSeconds ? 'Expires in ' + Math.round(info.expiresInSeconds / 60) + ' minutes.' : '',
      ].filter(Boolean).join('\\n');

      console.log('DEVICE_CODE:', info.userCode);
      console.log('DEVICE_URL:', info.verificationUri);
      updateState({
        status: 'auth_url_received',
        authUrl: info.verificationUri,
        instructions,
        deviceCode: info.userCode,
        updatedAt: Date.now()
      });
    };

    const handlePromptCode = async (prompt) => {
      const promptObject = typeof prompt === 'string' ? { message: prompt } : prompt || {};
      const message = promptObject.message || '';
      console.log('WAITING_FOR_CODE', message);

      if (promptObject.allowEmpty) {
        updateState({ status: 'waiting_for_auth', prompt: message, updatedAt: Date.now() });
        return '';
      }

      updateState({ status: 'waiting_for_code', updatedAt: Date.now() });
      
      // Wait for the code file to be created by the exchange endpoint
      const codeFile = ${stateFileLiteral}.replace('.json', '_code.txt');
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

    const handleSelect = async (prompt) => {
      const selected = prompt.options?.[0]?.id;
      console.log('SELECT:', prompt.message, selected);
      updateState({
        selectedOption: selected,
        selectionPrompt: prompt.message,
        updatedAt: Date.now()
      });
      return selected;
    };

    let credentials;
    // ${provider} uses options object
    credentials = await ${loginFn}({
      onAuth: handleAuthUrl,
      onDeviceCode: handleDeviceCode,
      onPrompt: handlePromptCode,
      ${provider === 'anthropic' || provider === 'openai-codex' ? 'onManualCodeInput: handlePromptCode,' : ''}
      onProgress: handleProgress,
      onSelect: handleSelect
    });

    // Save credentials
    fs.writeFileSync(${tempAuthPathLiteral}, JSON.stringify(credentials, null, 2));
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
  };
  return map[provider] || 'loginAnthropic';
}
