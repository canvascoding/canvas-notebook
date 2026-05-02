import 'server-only';

import { getComposio } from './composio-client';
import { getComposioSession, getComposioUserId } from './composio-session';

export async function initiateConnection(toolkit: string): Promise<{ redirectUrl: string | null; noAuth?: boolean }> {
  const composio = await getComposio();
  if (!composio) throw new Error('Composio not configured');

  const response = await composio.toolkits.get({});
  const rawItems = 'items' in response ? (response as { items: unknown[] }).items : Array.isArray(response) ? response : [];
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
  const composio = await getComposio();
  if (!composio) throw new Error('Composio not configured');

  const userId = getComposioUserId();
  const { items: accounts } = await composio.connectedAccounts.list({ userIds: [userId] });
  const account = accounts.find((a) => a.toolkit?.slug === toolkit);
  if (account) {
    await composio.connectedAccounts.delete(account.id);
  }
}

export async function getConnectedAccounts() {
  const composio = await getComposio();
  if (!composio) return [];

  const userId = getComposioUserId();
  const { items } = await composio.connectedAccounts.list({ userIds: [userId] });
  return items;
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