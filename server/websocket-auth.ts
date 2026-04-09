/**
 * WebSocket Authentication
 * 
 * Resolves the authenticated better-auth session from the WebSocket handshake
 * headers so the socket uses the same auth path as the rest of the app.
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

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      webHeaders.append(key, value);
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        webHeaders.append(key, entry);
      }
    }
  }

  return webHeaders;
}

/**
 * Extract and validate session from WebSocket handshake headers.
 */
export async function authenticateWebSocketConnection(
  headers: IncomingHttpHeaders
): Promise<WebSocketAuthResult> {
  try {
    const session = await auth.api.getSession({ headers: toWebHeaders(headers) });

    if (!session?.user?.id) {
      return {
        isAuthenticated: false,
        error: 'No valid session found',
      };
    }

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
