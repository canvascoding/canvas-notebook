import { safeAppReturnTo } from '@/app/lib/auth/return-to';

/** A connection setup can only return to the Plugins app, never an external site. */
export function safePluginReturnTo(value: unknown): string | null {
  const path = safeAppReturnTo(value);
  if (!path) return null;
  const url = new URL(path, 'https://canvas.invalid');
  return /^\/(?:de\/|en\/)?plugins\/?$/u.test(url.pathname) ? path : null;
}

export function pluginSetupSettingsHref(section: 'composio' | 'email', returnTo: string, workspaceId?: string): string {
  const query = new URLSearchParams({ tab: 'integrations', section });
  const safeReturnTo = safePluginReturnTo(returnTo);
  if (safeReturnTo) query.set('returnTo', safeReturnTo);
  if (workspaceId) query.set('workspaceId', workspaceId);
  return `/settings?${query}`;
}
