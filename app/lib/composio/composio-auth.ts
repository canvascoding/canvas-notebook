import 'server-only';

import { getComposio } from './composio-client';
import { getComposioSession, getComposioUserId } from './composio-session';
import { getAvailableToolkitsRaw } from './composio-toolkit-registry';

export type ComposioConnectedAccountStatus =
  | 'INITIALIZING'
  | 'INITIATED'
  | 'ACTIVE'
  | 'FAILED'
  | 'EXPIRED'
  | 'INACTIVE'
  | 'REVOKED';

type ConnectedAccountListOptions = {
  statuses?: ComposioConnectedAccountStatus[];
};

export async function initiateConnection(toolkit: string): Promise<{ redirectUrl: string | null; noAuth?: boolean }> {
  const composio = await getComposio();
  if (!composio) throw new Error('Composio not configured');

  const rawItems = await getAvailableToolkitsRaw();
  const toolkitInfo = rawItems.find((item) => {
    const t = item as Record<string, unknown>;
    return t.slug === toolkit;
  });
  const info = toolkitInfo as Record<string, unknown> | undefined;
  const isNoAuth = Boolean(info?.noAuth ?? info?.isNoAuth);

  if (isNoAuth) {
    return { redirectUrl: null, noAuth: true };
  }

  const session = await getComposioSession();
  if (!session) throw new Error('Composio not configured');

  const callbackUrl = `${getAppBaseUrl()}/api/composio/callback`;
  const connectionRequest = await session.authorize(toolkit, { callbackUrl });
  return { redirectUrl: connectionRequest.redirectUrl };
}

export async function disconnectTool(toolkit: string): Promise<void> {
  const accounts = await getConnectedAccounts();
  const account = accounts.find((a) => a.toolkit?.slug === toolkit);

  if (account) {
    const composio = await getComposio();
    if (!composio) throw new Error('Composio not configured');
    await composio.connectedAccounts.delete((account as { id: string }).id);
  }
}

export async function getAuthConfigs(): Promise<Array<Record<string, unknown>>> {
  const composio = await getComposio();
  if (!composio) return [];

  try {
    const result = await composio.authConfigs.list({});
    const listResult = result as Record<string, unknown>;
    const items = Array.isArray(listResult.items) ? listResult.items : [];
    return items as Array<Record<string, unknown>>;
  } catch (error) {
    console.error('[Composio] Failed to fetch auth configs:', error);
    return [];
  }
}

export async function getConnectedAccounts(options: ConnectedAccountListOptions = {}) {
  const composio = await getComposio();
  if (!composio) return [];

  const userId = await getComposioUserId();
  const allItems: Array<{ id: string; toolkit?: { slug?: string; name?: string }; status?: string; createdAt?: string; [key: string]: unknown }> = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, unknown> = { userIds: [userId], limit: 100 };
    if (options.statuses?.length) params.statuses = options.statuses;
    if (cursor) params.cursor = cursor;
    const result = await composio.connectedAccounts.list(params as Parameters<typeof composio.connectedAccounts.list>[0]);
    const items = Array.isArray(result.items) ? result.items : [];
    allItems.push(...(items as typeof allItems));
    cursor = ((result as Record<string, unknown>).nextCursor as string | undefined) ?? undefined;
  } while (cursor);

  return allItems;
}

export async function getActiveConnectedAccounts() {
  return getConnectedAccounts({ statuses: ['ACTIVE'] });
}

export async function getToolkitsWithStatus() {
  const session = await getComposioSession();
  if (!session) return [];

  const { items } = await session.toolkits();
  return items;
}

export function isToolkitConnected(accounts: Array<{ toolkit?: { slug?: string }; status?: string }>, toolkit: string): boolean {
  return accounts.some(
    (a) => a.toolkit?.slug === toolkit && a.status === 'ACTIVE'
  );
}

function getAppBaseUrl(): string {
  const baseUrl = process.env.BASE_URL || process.env.APP_BASE_URL;
  if (baseUrl) return baseUrl;
  const port = process.env.PORT || '3000';
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return `http://localhost:${port}`;
}
