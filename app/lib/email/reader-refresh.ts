export type EmailMessageRevisionInput = {
  attachments?: Array<{
    contentType?: string;
    filename: string;
    size?: number;
  }>;
  body?: string;
  bodyHtml?: string;
  cc?: string[] | string;
  date: string;
  folder?: string;
  from: string;
  id: string;
  subject: string;
  to?: string[] | string;
};

export function emailMessageContentRevision(message: EmailMessageRevisionInput): string {
  return JSON.stringify([
    message.folder || '',
    message.id,
    message.from,
    message.to || [],
    message.cc || [],
    message.subject,
    message.date,
    message.body || '',
    message.bodyHtml || '',
    (message.attachments || []).map((attachment) => [attachment.filename, attachment.contentType || '', attachment.size || 0]),
  ]);
}

export function emailMessageListScopeKey({
  accountId,
  filter,
  folder,
  page,
  query,
}: {
  accountId: string;
  filter: string;
  folder: string;
  page: number;
  query: string;
}): string {
  return JSON.stringify([accountId, folder, filter, query, page]);
}

export function emailMessageDetailScopeKey({
  accountId,
  folder,
  messageId,
}: {
  accountId: string;
  folder: string;
  messageId: string;
}): string {
  return JSON.stringify([accountId, folder, messageId]);
}

export const EMAIL_CACHE_FOLLOW_UP_DELAY_MS = 1_200;

export type EmailClientCacheMetadata = {
  state: 'fresh' | 'stale' | 'miss';
  refreshQueued: boolean;
  generation: number | null;
  fetchedAt: string | null;
  staleAt: string | null;
};

function cacheRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cacheTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

export function parseEmailClientCacheMetadata(value: unknown): EmailClientCacheMetadata | null {
  const candidate = cacheRecord(value);
  if (!candidate || !['fresh', 'stale', 'miss'].includes(String(candidate.state))) return null;
  const generation = candidate.generation === null || candidate.generation === undefined
    ? null
    : Number(candidate.generation);
  return {
    state: candidate.state as EmailClientCacheMetadata['state'],
    refreshQueued: candidate.refreshQueued === true,
    generation: generation !== null && Number.isSafeInteger(generation) ? generation : null,
    fetchedAt: cacheTimestamp(candidate.fetchedAt),
    staleAt: cacheTimestamp(candidate.staleAt),
  };
}

export function emailCacheFollowUpKey(scopeKey: string, value: unknown): string | null {
  const cache = parseEmailClientCacheMetadata(value);
  if (!cache || cache.state !== 'stale' || !cache.refreshQueued) return null;
  return JSON.stringify([scopeKey, cache.generation, cache.fetchedAt, cache.staleAt]);
}

export function claimEmailCacheFollowUp(seen: Set<string>, key: string | null, maxEntries = 200): boolean {
  if (!key || seen.has(key)) return false;
  seen.add(key);
  while (seen.size > maxEntries) {
    const oldest = seen.values().next().value;
    if (typeof oldest !== 'string') break;
    seen.delete(oldest);
  }
  return true;
}

export function shouldApplyEmailRefresh(input: {
  requestEpoch: number;
  currentEpoch: number;
  mutationRevision: number;
  currentMutationRevision: number;
  mutationInFlight: boolean;
}): boolean {
  return !input.mutationInFlight
    && input.requestEpoch === input.currentEpoch
    && input.mutationRevision === input.currentMutationRevision;
}
