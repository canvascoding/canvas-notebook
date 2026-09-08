import type { ChatMessage, PersistedChatMessage } from '@/app/lib/chat/types';

export type ChatExportFormat = 'markdown' | 'text' | 'json';

export type ChatExportSession = {
  sessionId: string;
  title: string;
  agentId: string;
  agentName: string;
  model: string;
  provider: string | null;
  thinkingLevel: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
};

export type ChatExportMessage = {
  source: 'persisted' | 'live';
  status?: ChatMessage['status'];
  message: Record<string, unknown>;
};

export type ChatExportDocument = {
  schemaVersion: 1;
  exportedAt: string;
  session: ChatExportSession;
  snapshot: {
    runtimePhase: string | null;
    active: boolean;
    messageCount: number;
    transientMessageCount: number;
    binaryPayloads: 'omitted';
  };
  messages: ChatExportMessage[];
};

export type ChatExportLabels = {
  agent: string;
  assistant: string;
  binaryOmitted: string;
  callId: string;
  chat: string;
  compactBreak: string;
  details: string;
  exportedAt: string;
  input: string;
  liveSnapshot: string;
  model: string;
  output: string;
  provider: string;
  runtimePhase: string;
  sessionId: string;
  system: string;
  tool: string;
  user: string;
  workspace: string;
};

const PRIVATE_CONTENT_KEYS = new Set([
  'thinking',
  'thinkingContent',
  'thinkingSignature',
  'reasoning',
  'reasoningContent',
  'reasoningDetails',
]);
const PRIVATE_PART_TYPES = new Set(['thinking', 'reasoning', 'redacted_thinking']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripPrivateReasoningTags(value: string): string {
  return value
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<\/?thinking>/gi, '')
    .replace(/<\/?reasoning>/gi, '');
}

function isReferenceLikeImageData(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('file://')
    || value.startsWith('http://')
    || value.startsWith('https://');
}

export function sanitizeChatExportValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripPrivateReasoningTags(value);
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isRecord(entry) || typeof entry.type !== 'string' || !PRIVATE_PART_TYPES.has(entry.type))
      .map((entry) => sanitizeChatExportValue(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const inlineImageData = value.type === 'image'
    && typeof value.data === 'string'
    && !isReferenceLikeImageData(value.data)
    ? value.data
    : null;
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_CONTENT_KEYS.has(key)) {
      continue;
    }
    if (inlineImageData !== null && key === 'data') {
      result.data = '[binary image payload omitted]';
      result.exportOmission = {
        kind: 'binary-image',
        originalCharacterCount: inlineImageData.length,
      };
      continue;
    }
    result[key] = sanitizeChatExportValue(entry);
  }

  return result;
}

export function parsePersistedChatMessageForExport(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  const sanitized = sanitizeChatExportValue(parsed);
  if (!isRecord(sanitized)) {
    throw new Error('Persisted chat message is not an object.');
  }
  return sanitized;
}

function messageTimestamp(message: Record<string, unknown>): number | string | null {
  if (typeof message.timestamp === 'number' || typeof message.timestamp === 'string') {
    return message.timestamp;
  }
  if (typeof message.createdAt === 'string') {
    return message.createdAt;
  }
  return null;
}

function messageIdentity(message: Record<string, unknown>): string | null {
  if (typeof message.id === 'number' || typeof message.id === 'string') {
    return `id:${message.id}`;
  }
  if (typeof message.sequence === 'number') {
    return `sequence:${message.sequence}`;
  }
  const timestamp = messageTimestamp(message);
  const role = typeof message.role === 'string' ? message.role : '';
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  return timestamp === null ? null : `message:${role}:${timestamp}:${toolCallId}`;
}

function liveMessageRecord(message: ChatMessage): Record<string, unknown> {
  const piMessage = sanitizeChatExportValue(message.piMessage);
  if (isRecord(piMessage)) {
    return piMessage;
  }

  return {
    id: message.id,
    role: message.role,
    content: sanitizeChatExportValue(message.content),
    type: message.type,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    toolArgs: message.toolArgs,
    attachments: sanitizeChatExportValue(message.attachments),
  };
}

export function buildChatExportDocument(input: {
  exportedAt?: string;
  liveMessages?: ChatMessage[];
  persistedMessages: PersistedChatMessage[];
  runtimePhase?: string | null;
  session: ChatExportSession;
}): ChatExportDocument {
  const persisted = input.persistedMessages.map((message) => ({
    source: 'persisted' as const,
    message: sanitizeChatExportValue(message) as Record<string, unknown>,
  }));
  const persistedIdentities = new Set(
    persisted.map((entry) => messageIdentity(entry.message)).filter((identity): identity is string => Boolean(identity)),
  );
  const live = (input.liveMessages || [])
    .map((message) => ({
      source: 'live' as const,
      status: message.status,
      message: liveMessageRecord(message),
    }))
    .filter((entry) => {
      const identity = messageIdentity(entry.message);
      return !identity || !persistedIdentities.has(identity);
    });
  const messages = [...persisted, ...live];

  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt || new Date().toISOString(),
    session: input.session,
    snapshot: {
      runtimePhase: input.runtimePhase || null,
      active: Boolean(input.runtimePhase && input.runtimePhase !== 'idle'),
      messageCount: messages.length,
      transientMessageCount: live.length,
      binaryPayloads: 'omitted',
    },
    messages,
  };
}

function formatTimestamp(value: number | string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function fencedBlock(value: string, language = ''): string {
  const longestFence = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function getRoleLabel(role: unknown, labels: ChatExportLabels): string {
  if (role === 'user') return labels.user;
  if (role === 'assistant') return labels.assistant;
  if (role === 'toolResult') return labels.tool;
  return labels.system;
}

function formatReadableMessage(
  entry: ChatExportMessage,
  labels: ChatExportLabels,
  format: 'markdown' | 'text',
): string {
  const message = entry.message;
  const role = typeof message.role === 'string' ? message.role : 'system';
  const timestamp = formatTimestamp(messageTimestamp(message));
  const liveMarker = entry.source === 'live' ? ` · ${labels.liveSnapshot}` : '';
  const heading = format === 'markdown'
    ? `## ${getRoleLabel(role, labels)}${timestamp ? ` · ${timestamp}` : ''}${liveMarker}`
    : `${getRoleLabel(role, labels).toUpperCase()}${timestamp ? ` · ${timestamp}` : ''}${liveMarker}`;

  if (role === 'compact-break') {
    const count = typeof message.omittedMessageCount === 'number' ? ` (${message.omittedMessageCount})` : '';
    return `${heading}\n\n${labels.compactBreak}${count}`;
  }

  const content = message.content;
  const sections: string[] = [];
  if (typeof content === 'string' && content.trim()) {
    sections.push(content.trim());
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        sections.push(part.text.trim());
        continue;
      }
      if (part.type === 'toolCall') {
        const toolName = typeof part.name === 'string' ? part.name : labels.tool;
        const callId = typeof part.id === 'string' ? part.id : '';
        const args = stringifyValue(part.arguments);
        const title = format === 'markdown' ? `### ${labels.tool}: ${toolName}` : `${labels.tool.toUpperCase()}: ${toolName}`;
        const details = [title, callId ? `${labels.callId}: ${callId}` : ''];
        if (args) {
          details.push(`${labels.input}:`, format === 'markdown' ? fencedBlock(args, 'json') : args);
        }
        sections.push(details.filter(Boolean).join('\n\n'));
        continue;
      }
      if (part.type === 'image') {
        const mimeType = typeof part.mimeType === 'string' ? part.mimeType : 'image';
        const data = typeof part.data === 'string' ? part.data : '';
        sections.push(data === '[binary image payload omitted]'
          ? `[${labels.binaryOmitted}: ${mimeType}]`
          : `[${mimeType}: ${data}]`);
        continue;
      }
      sections.push(format === 'markdown'
        ? fencedBlock(stringifyValue(part), 'json')
        : stringifyValue(part));
    }
  }

  if (role === 'toolResult') {
    const toolName = typeof message.toolName === 'string' ? message.toolName : null;
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : null;
    const output = sections.join('\n\n');
    sections.length = 0;
    if (toolName) sections.push(`${labels.tool}: ${toolName}`);
    if (callId) sections.push(`${labels.callId}: ${callId}`);
    if (output) {
      sections.push(`${labels.output}:`, format === 'markdown' ? fencedBlock(output) : output);
    }
  }

  if (message.details !== undefined) {
    const details = stringifyValue(message.details);
    if (details) {
      sections.push(`${labels.details}:`, format === 'markdown' ? fencedBlock(details, 'json') : details);
    }
  }

  if (typeof message.errorMessage === 'string' && message.errorMessage.trim()) {
    sections.push(`Error: ${message.errorMessage.trim()}`);
  }

  return `${heading}\n\n${sections.filter(Boolean).join('\n\n')}`.trimEnd();
}

function formatHeader(document: ChatExportDocument, labels: ChatExportLabels, format: 'markdown' | 'text'): string {
  const lines = [
    `${labels.sessionId}: ${document.session.sessionId}`,
    `${labels.exportedAt}: ${document.exportedAt}`,
    `${labels.agent}: ${document.session.agentName} (${document.session.agentId})`,
    `${labels.model}: ${document.session.model}`,
    `${labels.provider}: ${document.session.provider || '-'}`,
    `${labels.workspace}: ${document.session.workspaceName || '-'}${document.session.workspaceId ? ` (${document.session.workspaceId})` : ''}`,
    `${labels.runtimePhase}: ${document.snapshot.runtimePhase || 'idle'}`,
  ];
  const title = document.session.title || labels.chat;
  return format === 'markdown'
    ? `# ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}`
    : `${title}\n${'='.repeat(title.length)}\n${lines.join('\n')}`;
}

export function formatChatExport(
  document: ChatExportDocument,
  format: ChatExportFormat,
  labels: ChatExportLabels,
): string {
  if (format === 'json') {
    return JSON.stringify(document, null, 2);
  }

  return [
    formatHeader(document, labels, format),
    ...document.messages.map((message) => formatReadableMessage(message, labels, format)),
  ].join('\n\n');
}
