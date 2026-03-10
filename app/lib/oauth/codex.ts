import crypto from 'crypto';
import { openDb } from '../db';

interface PKCEData {
  codeVerifier: string;
  codeChallenge: string;
}

interface OAuthStateData {
  userId: string;
  codeVerifier: string;
  createdAt: number;
}

// In-memory store for OAuth states (TTL: 15 minutes)
const oauthStates = new Map<string, OAuthStateData>();

const STATE_TTL = 15 * 60 * 1000; // 15 minutes

export function generatePKCE(): PKCEData {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export async function storeOAuthState(userId: string, pkce: PKCEData): Promise<string> {
  const state = crypto.randomBytes(16).toString('hex');
  
  oauthStates.set(state, {
    userId,
    codeVerifier: pkce.codeVerifier,
    createdAt: Date.now(),
  });
  
  // Schedule cleanup
  setTimeout(() => {
    oauthStates.delete(state);
  }, STATE_TTL);
  
  return state;
}

export function verifyOAuthState(state: string, userId: string): string | null {
  const data = oauthStates.get(state);
  
  if (!data) {
    return null;
  }
  
  if (data.userId !== userId) {
    return null;
  }
  
  if (Date.now() - data.createdAt > STATE_TTL) {
    oauthStates.delete(state);
    return null;
  }
  
  // Clean up after verification
  oauthStates.delete(state);
  
  return data.codeVerifier;
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope: string;
  email?: string;
} | null> {
  const clientId = process.env.OPENAI_CODEX_CLIENT_ID || 'openai-codex-cli';
  const clientSecret = process.env.OPENAI_CODEX_CLIENT_SECRET || '';
  const redirectUri = process.env.OPENAI_CODEX_REDIRECT_URI || 'http://localhost:3000/callback';
  
  const tokenUrl = 'https://auth.openai.com/token';
  
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }
  
  const data = await response.json();
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope || 'codex',
    email: data.user?.email,
  };
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
} | null> {
  const clientId = process.env.OPENAI_CODEX_CLIENT_ID || 'openai-codex-cli';
  const clientSecret = process.env.OPENAI_CODEX_CLIENT_SECRET || '';
  
  const tokenUrl = 'https://auth.openai.com/token';
  
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }
  
  const data = await response.json();
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}
