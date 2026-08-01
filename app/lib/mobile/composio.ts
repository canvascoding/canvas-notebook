import 'server-only';

import type { ComposioStatusResult } from '@/app/lib/composio/composio-gateway';
import { resolveComposioToolkitAccess } from '@/app/lib/composio/composio-toolkit-access';

export type MobileComposioToolkit = {
  slug: string;
  name: string;
  description: string;
  category: string;
  logo: string;
  initials: string;
  noAuth: boolean;
  connected: boolean;
  connectionStatus: string;
  toolsCount: number;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function initialsFor(value: string): string {
  const words = value.replace(/[-_]+/gu, ' ').trim().split(/\s+/gu).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
}

export function serializeMobileComposioToolkit(
  value: unknown,
  connectedStatusBySlug: ReadonlyMap<string, string>,
): MobileComposioToolkit | null {
  const record = recordValue(value);
  const meta = recordValue(record.meta);
  const slug = textValue(record.slug);
  if (!slug || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(slug)) return null;
  const name = textValue(record.name) || slug;
  const connectedStatus = connectedStatusBySlug.get(slug) || textValue(record.connectedAccountStatus);
  const access = resolveComposioToolkitAccess(record, Boolean(connectedStatus === 'ACTIVE' || record.connected));
  const categories = Array.isArray(meta.categories)
    ? meta.categories.map(textValue).filter(Boolean)
    : Array.isArray(record.categories)
      ? record.categories.map(textValue).filter(Boolean)
      : [];
  return {
    slug,
    name,
    description: textValue(meta.description) || textValue(record.description),
    category: textValue(meta.category) || textValue(record.category) || categories[0] || 'Apps',
    logo: textValue(meta.logo) || textValue(record.logo),
    initials: initialsFor(name),
    noAuth: access.noAuth,
    connected: access.ready,
    connectionStatus: access.ready ? 'ACTIVE' : connectedStatus,
    toolsCount: numberValue(meta.toolsCount)
      || numberValue(record.toolsCount)
      || numberValue(record.toolCount)
      || (Array.isArray(record.tools) ? record.tools.length : 0),
  };
}

export function connectedComposioStatusBySlug(
  status: ComposioStatusResult,
): Map<string, string> {
  return new Map(status.connectedAccounts
    .filter((account) => account.toolkit.slug)
    .map((account) => [account.toolkit.slug, account.status || 'ACTIVE']));
}

export function serializeMobileComposioStatus(status: ComposioStatusResult, profile: {
  id: string;
  name: string;
  source: string;
}) {
  return {
    available: status.configured && status.apiKeyValid,
    configured: status.configured,
    providerHealthy: status.apiKeyValid,
    mode: status.mode,
    connectedCount: status.connectedAccounts.length,
    profile,
  };
}

export function serializeMobileComposioTool(value: unknown) {
  const record = recordValue(value);
  const slug = textValue(record.slug) || textValue(record.name);
  if (!slug) return null;
  return {
    slug,
    name: textValue(record.name) || slug,
    description: textValue(record.description),
  };
}
