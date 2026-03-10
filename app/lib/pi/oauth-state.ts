/**
 * OAuth State Manager
 * Manages in-progress OAuth flows
 */

import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth';
import type { OAuthProviderId } from './oauth';

interface OAuthFlow {
  id: string;
  provider: OAuthProviderId;
  authUrl?: string;
  instructions?: string;
  status: 'pending' | 'waiting_for_code' | 'completed' | 'failed';
  credentials?: OAuthCredentials;
  error?: string;
  createdAt: number;
}

// In-memory store for active OAuth flows
const activeFlows = new Map<string, OAuthFlow>();

const FLOW_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Create a new OAuth flow
 */
export function createOAuthFlow(provider: OAuthProviderId): OAuthFlow {
  const id = `oauth_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const flow: OAuthFlow = {
    id,
    provider,
    status: 'pending',
    createdAt: Date.now(),
  };
  activeFlows.set(id, flow);
  
  // Auto-cleanup after timeout
  setTimeout(() => {
    if (activeFlows.has(id)) {
      activeFlows.delete(id);
    }
  }, FLOW_TIMEOUT);
  
  return flow;
}

/**
 * Get an OAuth flow by ID
 */
export function getOAuthFlow(id: string): OAuthFlow | undefined {
  return activeFlows.get(id);
}

/**
 * Update an OAuth flow
 */
export function updateOAuthFlow(
  id: string, 
  updates: Partial<Omit<OAuthFlow, 'id' | 'createdAt'>>
): OAuthFlow | undefined {
  const flow = activeFlows.get(id);
  if (!flow) return undefined;
  
  Object.assign(flow, updates);
  return flow;
}

/**
 * Delete an OAuth flow
 */
export function deleteOAuthFlow(id: string): boolean {
  return activeFlows.delete(id);
}

/**
 * Cleanup old flows
 */
export function cleanupOldFlows(): void {
  const now = Date.now();
  for (const [id, flow] of activeFlows.entries()) {
    if (now - flow.createdAt > FLOW_TIMEOUT) {
      activeFlows.delete(id);
    }
  }
}
