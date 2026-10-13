'use client';

import type { McpConfigState } from '@/app/lib/mcp/config';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { McpAuthorizationError } from '@/app/lib/desktop/mcp-oauth-client';
import { collectMcpEnvEntries, updateMcpConfigRawServer, type McpServerDraft } from './McpServerDialog';

export async function patchPersonalIntegrationEnv(patches: Array<{key: string; value: string | null}>, errorMessage: string,
  options: {signal?: AbortSignal; workspaceId?: string | null} = {}): Promise<void> {
  const response = await fetch('/api/integrations/env?scope=integrations', {method: 'PATCH', credentials: 'include', signal: options.signal,
    headers: {'Content-Type': 'application/json', ...(options.workspaceId ? {[WORKSPACE_ID_HEADER]: options.workspaceId} : {})},
    body: JSON.stringify({scope: 'integrations', secretScope: 'user', patches})});
  const result = await response.json();
  if (!response.ok || !result.success) throw new McpAuthorizationError(result.code || 'request_failed', result.error || errorMessage);
  window.dispatchEvent(new CustomEvent('canvas_secrets_updated', {detail: {secretScope: 'user'}}));
}

/** Shared save mechanics; scope choice, form state and success navigation stay with the caller. */
export async function savePersonalMcpServer(input: {rawContent: string; draft: McpServerDraft; originalName?: string;
  envError: string; saveError: string; workspaceId?: string | null; signal?: AbortSignal; isCurrent?: () => boolean}): Promise<McpConfigState> {
  const current = () => {
    input.signal?.throwIfAborted();
    if (input.isCurrent && !input.isCurrent()) throw new DOMException('The connection context changed.', 'AbortError');
  };
  current();
  const rawContent = updateMcpConfigRawServer(input.rawContent, input.draft, input.originalName), patches = collectMcpEnvEntries(input.draft);
  if (patches.length) await patchPersonalIntegrationEnv(patches, input.envError, input);
  current();
  const response = await fetch('/api/integrations/mcp-config', {method: 'PUT', credentials: 'include', signal: input.signal,
    headers: {'Content-Type': 'application/json', ...(input.workspaceId ? {[WORKSPACE_ID_HEADER]: input.workspaceId} : {})}, body: JSON.stringify({rawContent})});
  const result = await response.json();
  if (!response.ok || !result.success) throw new McpAuthorizationError(result.code || 'request_failed', result.error || input.saveError);
  current();
  return result.data as McpConfigState;
}
