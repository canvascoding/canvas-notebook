import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImagePart(value: UnknownRecord): boolean {
  return value.type === 'image' && typeof value.data === 'string';
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\');
}

function isServerPathField(key: string): boolean {
  return key === 'path' || key.endsWith('Path');
}

function projectVisualValue(value: unknown, purpose: 'persistence' | 'external-event'): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => projectVisualValue(entry, purpose));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isImagePart(value)) {
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : 'image';
    return {
      type: 'text',
      text: `[${mimeType} image omitted from ${purpose === 'persistence' ? 'persisted chat history' : 'live event'}; reopen or read the authorized source to analyze it.]`,
    };
  }

  const projected: UnknownRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    // Absolute real paths are only needed while the server executes a tool.
    if (key === 'resolvedPath') continue;
    if (isServerPathField(key) && typeof entry === 'string' && isAbsoluteFilesystemPath(entry)) continue;
    projected[key] = projectVisualValue(entry, purpose);
  }
  return projected;
}

/** Removes binary image payloads and server-only resolved paths before DB writes. */
export function projectAgentMessageForPersistence(message: AgentMessage): AgentMessage {
  return projectVisualValue(message, 'persistence') as AgentMessage;
}

/** Removes binary image payloads and server-only resolved paths before client/log transport. */
export function projectAgentEventForExternal<T extends Record<string, unknown>>(event: T): T {
  return projectVisualValue(event, 'external-event') as T;
}
