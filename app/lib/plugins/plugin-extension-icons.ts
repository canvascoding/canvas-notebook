/** Public image metadata only. Never include credential-bearing query strings. */
export type PluginExtensionIcon = { url: string; sourceKey: string };

export function publicPluginExtensionIcon(value: unknown, sourceKey: string): PluginExtensionIcon | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.search = ''; url.hash = '';
    return { url: url.href, sourceKey: `${sourceKey}:${url.href}` };
  } catch { return undefined; }
}

/** The image route rechecks human read access and exact current source on every request. */
export function installedPluginExtensionIcon(resourceRef: string, revision: number, workspaceId?: string | null,
  childName?: string): PluginExtensionIcon {
  const query = new URLSearchParams({ revision: String(revision) });
  if (workspaceId) query.set('workspaceId', workspaceId);
  if (childName) query.set('childName', childName);
  const url = `/api/capabilities/packages/${encodeURIComponent(resourceRef)}/icon?${query}`;
  return { url, sourceKey: `${workspaceId ?? ''}:${resourceRef}:${revision}:${childName ?? ''}` };
}

/** Lazy authenticated image delivery; the binding contains no provider URL or credentials. */
export function mcpPluginExtensionIcon(selectionId: string, binding: string, workspaceId?: string | null): PluginExtensionIcon {
  const query = new URLSearchParams({ binding });
  if (workspaceId) query.set('workspaceId', workspaceId);
  return { url: `/api/plugins/mcp-icons/${encodeURIComponent(selectionId)}?${query}`,
    sourceKey: `${workspaceId ?? ''}:${selectionId}:${binding}` };
}
