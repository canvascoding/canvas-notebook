import 'server-only';

import type {
  EmailCacheBackgroundScheduler,
  EmailResponseCacheMetadata,
} from '@/app/lib/email/cache/read-through';
import type { HomeWidgetEmail } from '@/app/lib/home/workspace-widget-data';

type HomeEmailAccount = {
  id: string;
  displayName?: string | null;
  emailAddress?: string | null;
};

type HomeEmailListPayload = {
  cache?: EmailResponseCacheMetadata;
  folder?: unknown;
  messages?: unknown[];
};

export type HomeEmailServices = {
  listAccounts: (userId: string) => Promise<{ accounts?: unknown[] }>;
  listMessages: (
    userId: string,
    input: { accountId: string; filter: 'unread'; limit: number },
    options: {
      enforceReadPolicy: false;
      cacheMode: 'swr';
      scheduleBackgroundTask?: EmailCacheBackgroundScheduler;
    },
  ) => Promise<HomeEmailListPayload>;
};

export type HomeWidgetEmailCacheMetadata = {
  enabled: boolean;
  state: EmailResponseCacheMetadata['state'];
  source: EmailResponseCacheMetadata['source'] | 'mixed' | 'none';
  fetchedAt: string | null;
  staleAt: string | null;
  expiresAt: string | null;
  refreshQueued: boolean;
  refreshToken: string;
  partial: boolean;
  accountCount: number;
  successfulAccountCount: number;
};

export type HomeWidgetEmailResult = {
  data: HomeWidgetEmail[];
  cachedAt: string;
  stale: boolean;
  cache: HomeWidgetEmailCacheMetadata;
};

type AccountResult = {
  accountId: string;
  cache: EmailResponseCacheMetadata;
  messages: HomeWidgetEmail[];
};

const MISSING_CACHE_METADATA: EmailResponseCacheMetadata = {
  enabled: false,
  scope: 'list',
  state: 'miss',
  source: 'bypass',
  generation: null,
  fetchedAt: null,
  staleAt: null,
  expiresAt: null,
  refreshQueued: false,
  bypassReason: 'cache_error',
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function account(value: unknown): HomeEmailAccount | null {
  const candidate = record(value);
  const id = typeof candidate?.id === 'string' ? candidate.id : '';
  if (!id.trim()) return null;
  return {
    id,
    displayName: typeof candidate?.displayName === 'string' ? candidate.displayName : null,
    emailAddress: typeof candidate?.emailAddress === 'string' ? candidate.emailAddress : null,
  };
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function earliestIso(values: Array<string | null>): string | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return values.reduce<string | null>((earliest, value) => (
    !earliest || timestamp(value) < timestamp(earliest) ? value : earliest
  ), null);
}

function stableToken(value: unknown): string {
  const input = JSON.stringify(value);
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    forward = Math.imul(forward ^ input.charCodeAt(index), 0x01000193) >>> 0;
    backward = Math.imul(backward ^ input.charCodeAt(input.length - index - 1), 0x01000193) >>> 0;
  }
  return `home-email-v1-${forward.toString(16).padStart(8, '0')}${backward.toString(16).padStart(8, '0')}`;
}

function aggregateHomeWidgetEmailCache(
  accountIds: string[],
  results: PromiseSettledResult<AccountResult>[],
): HomeWidgetEmailCacheMetadata {
  const successful = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const metadata = successful.map((result) => result.cache);
  const state = metadata.some((cache) => cache.state === 'stale')
    ? 'stale'
    : metadata.some((cache) => cache.state === 'miss')
      ? 'miss'
      : 'fresh';
  const sources = new Set(metadata.map((cache) => cache.source));
  const source = sources.size === 0 ? 'none' : sources.size === 1 ? [...sources][0]! : 'mixed';
  const tokenEntries = results
    .map((result, index) => ({ accountId: accountIds[index] || '', result }))
    .sort((left, right) => left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0)
    .map(({ accountId, result }) => result.status === 'rejected'
      ? { accountId, status: 'error' as const }
      : {
        accountId,
        state: result.value.cache.state,
        source: result.value.cache.source,
        generation: result.value.cache.generation,
        fetchedAt: result.value.cache.fetchedAt,
        messages: result.value.messages
          .map((message) => [message.folder || '', message.id, message.date])
          .sort((left, right) => {
            const leftKey = JSON.stringify(left);
            const rightKey = JSON.stringify(right);
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
      });

  return {
    enabled: metadata.length > 0 && metadata.every((cache) => cache.enabled),
    state,
    source,
    fetchedAt: earliestIso(metadata.map((cache) => cache.fetchedAt)),
    staleAt: earliestIso(metadata.map((cache) => cache.staleAt)),
    expiresAt: earliestIso(metadata.map((cache) => cache.expiresAt)),
    refreshQueued: metadata.some((cache) => cache.refreshQueued),
    refreshToken: stableToken(tokenEntries),
    partial: successful.length !== accountIds.length,
    accountCount: accountIds.length,
    successfulAccountCount: successful.length,
  };
}

export async function loadHomeWidgetEmails(
  userId: string,
  options: {
    scheduleBackgroundTask?: EmailCacheBackgroundScheduler;
    services: HomeEmailServices;
  },
): Promise<HomeWidgetEmailResult> {
  const services = options.services;
  const accountsPayload = await services.listAccounts(userId);
  const accounts = (accountsPayload.accounts ?? []).flatMap((value) => {
    const normalized = account(value);
    return normalized ? [normalized] : [];
  });

  const results = await Promise.allSettled(accounts.map(async (emailAccount): Promise<AccountResult> => {
    const payload = await services.listMessages(userId, {
      accountId: emailAccount.id,
      filter: 'unread',
      limit: 3,
    }, {
      enforceReadPolicy: false,
      cacheMode: 'swr',
      ...(options.scheduleBackgroundTask ? { scheduleBackgroundTask: options.scheduleBackgroundTask } : {}),
    });
    const fallbackFolder = typeof payload.folder === 'string' ? payload.folder : undefined;
    const accountLabel = emailAccount.displayName?.trim() || emailAccount.emailAddress?.trim() || emailAccount.id;
    const messages = (payload.messages ?? []).flatMap((value): HomeWidgetEmail[] => {
      const message = record(value);
      if (typeof message?.id !== 'string' || !message.id.trim() || message.isRead !== false) return [];
      const folder = typeof message.folder === 'string' && message.folder ? message.folder : fallbackFolder;
      return [{
        id: message.id,
        accountId: emailAccount.id,
        accountLabel,
        ...(folder ? { folder } : {}),
        from: typeof message.from === 'string' ? message.from.trim() : '',
        subject: typeof message.subject === 'string' ? message.subject.trim() : '',
        date: typeof message.date === 'string' && message.date ? message.date : null,
      }];
    });
    return {
      accountId: emailAccount.id,
      cache: payload.cache ?? MISSING_CACHE_METADATA,
      messages,
    };
  }));

  if (accounts.length > 0 && results.every((result) => result.status === 'rejected')) {
    throw new Error('Email widget data could not be loaded.');
  }

  const cache = aggregateHomeWidgetEmailCache(accounts.map((value) => value.id), results);
  const data = results
    .flatMap((result) => result.status === 'fulfilled' ? result.value.messages : [])
    .sort((left, right) => timestamp(right.date) - timestamp(left.date))
    .slice(0, 3);
  return {
    data,
    cachedAt: cache.fetchedAt ?? new Date().toISOString(),
    stale: cache.state === 'stale',
    cache,
  };
}
