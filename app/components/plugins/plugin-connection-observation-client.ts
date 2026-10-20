'use client';

import type {IntegrationConnectionDescriptor} from '@/app/lib/integration-tools/connections/contracts';
import type {PluginExtensionConnection} from '@/app/lib/plugins/plugin-extension-contracts';
import {pluginIntegrationRequest} from './plugin-integration-client';
import {SharedConnectionRequestError} from './shared-connections-client';
import {isSharedConnectionConnected} from './shared-connection-oauth-state';

/** An explicit management selection checks saved sign-in metadata; it does not discover/call business tools. */
export async function inspectSharedPluginConnection(base: PluginExtensionConnection, source: 'mcp' | 'composio', workspaceId: string | null,
  options: {signal?: AbortSignal; noAuth?: boolean; isCurrent: () => boolean}): Promise<PluginExtensionConnection> {
  const current = () => { options.signal?.throwIfAborted(); if (!options.isCurrent()) throw new DOMException('The connection context changed.', 'AbortError'); };
  current();
  const path = `/api/integrations/shared-connections/${encodeURIComponent(base.connectionRef)}`;
  const inspect = async () => {
    const value = await pluginIntegrationRequest<{connection: IntegrationConnectionDescriptor}>(path, workspaceId, {signal: options.signal}); current();
    if (value.connection.resource.connectionRef !== base.connectionRef || value.connection.resource.source !== source || !value.connection.access.canRead
      || JSON.stringify(value.connection.resource.ownership) !== JSON.stringify(base.ownership)) throw new SharedConnectionRequestError(403, 'connection_context_changed');
    return value.connection;
  };
  const before = await inspect();
  const status = await pluginIntegrationRequest<unknown>(`/api/${source}/shared-connections/${encodeURIComponent(base.connectionRef)}/${source === 'mcp' ? 'oauth' : 'status'}`, workspaceId, {signal: options.signal});
  current();
  const after = await inspect();
  if (before.resource.metadataRevision !== after.resource.metadataRevision || before.resource.grantsRevision !== after.resource.grantsRevision || before.resource.bindingRevision !== after.resource.bindingRevision) {
    throw new SharedConnectionRequestError(409, 'connection_context_changed');
  }
  const connected = isSharedConnectionConnected(source, status), data = status && typeof status === 'object' ? status : {};
  let authorization: PluginExtensionConnection['authorization'] = 'unknown';
  if (connected) authorization = source === 'mcp' && Reflect.get(data, 'requiresAuth') === false || options.noAuth ? 'not_required' : 'authorized';
  else if (source === 'mcp' && Reflect.get(data, 'configured') === true && Reflect.get(data, 'requiresAuth') === true && !Reflect.get(data, 'code')) authorization = 'required';
  else if (source === 'composio') {
    const state: unknown = Reflect.get(data, 'status');
    if (state && typeof state === 'object' && Reflect.get(state, 'state') === 'auth_required') authorization = 'required';
  }
  return {...base, displayName: after.resource.displayName, access: after.access, enabled: after.resource.status === 'active', authorization};
}
