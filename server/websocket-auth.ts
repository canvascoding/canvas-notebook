/**
 * WebSocket Authentication
 * 
 * Validates better-auth session cookies from WebSocket handshake requests.
 */

import type { IncomingHttpHeaders } from 'http';
import { auth } from '@/app/lib/auth';

export interface WebSocketAuthResult {
  isAuthenticated: boolean;
  userId?: string;
  userEmail?: string;
  userName?: string;
  error?: string;
}

/**
 * Extract and validate session from WebSocket handshake headers
 */
export async function authenticateWebSocketConnection(
  headers: IncomingHttpHeaders
): Promise<WebSocketAuthResult> {
  try {
    console.log('[WebSocket Auth] Incoming headers keys:', Object.keys(headers));
    console.log('[WebSocket Auth] Cookie header:', headers.cookie || 'NOT SET');
    
    // Convert Node.js headers to Web Headers API
    const webHeaders = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        webHeaders.append(key, value);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          webHeaders.append(key, v);
        }
      }
    }

    // Get session using better-auth API
    const session = await auth.api.getSession({ headers: webHeaders });

    if (!session) {
      console.warn('[WebSocket Auth] No valid session found');
      return {
        isAuthenticated: false,
        error: 'No valid session found',
      };
    }

    console.log('[WebSocket Auth] User authenticated:', session.user.id);
    return {
      isAuthenticated: true,
      userId: session.user.id,
      userEmail: session.user.email,
      userName: session.user.name,
    };
  } catch (error) {
    console.error('[WebSocket Auth] Error:', error);
    return {
      isAuthenticated: false,
      error: error instanceof Error ? error.message : 'Authentication failed',
    };
  }
}

/**
 * Parse cookies from WebSocket handshake header
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  const result: Record<string, string> = {};
  
  cookieHeader.split(';').forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = decodeURIComponent(trimmed.slice(separatorIndex + 1).trim());
    result[key] = value;
  });
  
  return result;
}
