import type { AgentMessage } from '@earendil-works/pi-agent-core';

export function escapeSessionSearchLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function extractAgentMessageText(message: AgentMessage | null): string {
  if (!message) {
    return '';
  }
  if (!('content' in message)) {
    return `[${message.role}]`;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      if (part && typeof part === 'object' && 'type' in part && part.type === 'image') {
        return '[image]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function extractPersistedMessageText(content: string): string {
  try {
    return extractAgentMessageText(JSON.parse(content) as AgentMessage);
  } catch {
    return content;
  }
}

export function truncateSessionSearchText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function createSessionSearchSnippet(value: string, query: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const matchIndex = normalized.toLocaleLowerCase('en-US').indexOf(query.toLocaleLowerCase('en-US'));
  if (matchIndex < 0) {
    return truncateSessionSearchText(normalized, maxLength);
  }

  const contextLength = Math.max(0, maxLength - query.length);
  const start = Math.max(0, matchIndex - Math.floor(contextLength * 0.4));
  const end = Math.min(normalized.length, start + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';
  const available = Math.max(1, maxLength - prefix.length - suffix.length);
  return `${prefix}${normalized.slice(start, start + available).trim()}${suffix}`;
}

export function getSessionTitleSearchRank(title: string | null | undefined, query: string): number {
  const normalizedTitle = title?.trim().toLocaleLowerCase('en-US') || '';
  const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
  if (!normalizedTitle || !normalizedQuery) return 3;
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 1;
  return normalizedTitle.includes(normalizedQuery) ? 2 : 3;
}
