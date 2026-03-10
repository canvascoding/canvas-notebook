import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/**
 * POST /api/oauth/openai-codex/exchange
 * Verify that Codex CLI is authenticated and copy token to our storage
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

    // Read the codex config file
    const codexConfig = await readCodexConfig();
    
    if (!codexConfig) {
      return NextResponse.json(
        { success: false, error: 'Codex CLI not authenticated. Please open the auth URL in your browser first and complete the login.' },
        { status: 400 }
      );
    }

    // Extract token info from config
    const { email, token, expiresAt } = codexConfig;

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'No access token found in Codex CLI config. Please authenticate first.' },
        { status: 400 }
      );
    }

    // Store token in our database for the current user
    // This allows the token to be used by the PI agent
    await storeTokenForUser(session.user.id, {
      provider: 'openai-codex',
      email,
      accessToken: token,
      expiresAt,
    });

    return NextResponse.json({
      success: true,
      email: email || 'unknown',
      message: 'Successfully connected OpenAI account via Codex CLI',
    });
  } catch (error) {
    console.error('OAuth exchange failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to verify connection' },
      { status: 500 }
    );
  }
}

interface CodexConfig {
  email?: string;
  token?: string;
  expiresAt?: number;
}

async function readCodexConfig(): Promise<CodexConfig | null> {
  try {
    // Read codex config from ~/.codex/config.toml or ~/.codex/config.json
    const configPaths = [
      join(homedir(), '.codex', 'config.toml'),
      join(homedir(), '.codex', 'config.json'),
      join(homedir(), '.config', 'codex', 'config.toml'),
      join(homedir(), '.config', 'codex', 'config.json'),
    ];

    for (const configPath of configPaths) {
      try {
        const content = await readFile(configPath, 'utf-8');
        console.log('Found codex config at:', configPath);
        
        // Try to parse as JSON first
        if (configPath.endsWith('.json')) {
          const config = JSON.parse(content);
          return extractTokenInfo(config);
        }
        
        // Parse TOML (simplified - just look for key=value pairs)
        const config: Record<string, string> = {};
        for (const line of content.split('\n')) {
          const match = line.match(/^([\w.]+)\s*=\s*"?([^"\n]+)"?$/);
          if (match) {
            config[match[1]] = match[2];
          }
        }
        
        return extractTokenInfo(config);
      } catch {
        // File doesn't exist or can't be read, try next
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error('Error reading codex config:', error);
    return null;
  }
}

function extractTokenInfo(config: Record<string, unknown>): CodexConfig {
  // Codex stores token in different formats depending on version
  // Try common locations
  const token = config.access_token || config.token || config['api.access_token'];
  const email = config.email || config.user_email || config['api.email'];
  const expiresAt = config.expires_at || config.expires 
    ? new Date(String(config.expires_at || config.expires)).getTime() 
    : undefined;

  return {
    email: email ? String(email) : undefined,
    token: token ? String(token) : undefined,
    expiresAt,
  };
}

async function storeTokenForUser(
  userId: string, 
  data: { provider: string; email?: string; accessToken: string; expiresAt?: number }
): Promise<void> {
  // Store token in database or file
  // For now, we'll store it in a simple way
  // In production, this should use the existing oauth store
  
  const { storeToken } = await import('@/app/lib/oauth/store');
  
  await storeToken({
    id: crypto.randomUUID(),
    provider: data.provider,
    accessToken: data.accessToken,
    email: data.email,
    expiresAt: data.expiresAt,
    scope: 'codex',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
