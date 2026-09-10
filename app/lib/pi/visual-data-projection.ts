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

const DURABLE_CANVAS_PATH = /^\/data\/(?:agents|studio|user-uploads|workspace|workspaces)(?:\/|$)/;
const AUTHORIZED_UPLOAD_IMAGE_REFERENCE = /^\/api\/files\/[^/?#]+(?:\/preview)?(?:[?#].*)?$/;
const MCP_PERSISTED_DETAILS_LIMIT = 2 * 1024 * 1024;
const MCP_APP_DESCRIPTOR_KEYS = new Set(['version', 'connectionId', 'toolName', 'resourceUri']);

function isDurableCanvasPath(value: string): boolean {
  return DURABLE_CANVAS_PATH.test(value.replace(/\\/g, '/'));
}

function isAuthorizedUploadImageReference(
  value: UnknownRecord,
): value is UnknownRecord & { type: 'image'; data: string } {
  return value.type === 'image'
    && typeof value.data === 'string'
    && AUTHORIZED_UPLOAD_IMAGE_REFERENCE.test(value.data.trim());
}

const ABSOLUTE_PATH_TOKEN = /(?:^|(?<=[\s"'`(]))(?:\/(?:[^\s"'`<>()\[\]{}]+\/)+[^\s"'`<>()\[\]{}]+|[a-z]:[\\/](?:[^\s"'`<>()\[\]{}]+[\\/])+[^\s"'`<>()\[\]{}]+|\\\\(?:[^\s"'`<>()\[\]{}]+[\\/])+[^\s"'`<>()\[\]{}]+)/gi;

function redactAbsoluteFilesystemPaths(value: string, purpose: 'persistence' | 'external-event'): string {
  return value.replace(
    ABSOLUTE_PATH_TOKEN,
    (matchedPath) => (
      purpose === 'persistence' && isDurableCanvasPath(matchedPath)
        ? matchedPath
        : `[absolute server path omitted from ${purpose === 'persistence' ? 'persisted chat history' : 'live event'}]`
    ),
  );
}

function projectVisualValue(value: unknown, purpose: 'persistence' | 'external-event'): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => projectVisualValue(entry, purpose));
  }

  if (typeof value === 'string') {
    return redactAbsoluteFilesystemPaths(value, purpose);
  }

  if (!isRecord(value)) {
    return value;
  }

  // Upload URLs are stable, session-authorized references rather than binary
  // payloads. Keeping them lets a later turn re-authorize and reload the image.
  if (isAuthorizedUploadImageReference(value)) {
    return { ...value, data: value.data.trim() };
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
    // Runtime-resolved host paths never need persistence. Canonical Canvas data
    // paths remain useful in later turns and are safe within the session scope.
    if (key === 'resolvedPath') continue;
    if (
      isServerPathField(key)
      && typeof entry === 'string'
      && isAbsoluteFilesystemPath(entry)
      && !(purpose === 'persistence' && isDurableCanvasPath(entry))
    ) continue;
    projected[key] = projectVisualValue(entry, purpose);
  }
  return projected;
}

function boundedMcpDetails(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.mcpApp)) return value;
  if (JSON.stringify(value).length <= MCP_PERSISTED_DETAILS_LIMIT) return value;

  const mcpApp: UnknownRecord = {};
  for (const [key, entry] of Object.entries(value.mcpApp)) {
    if (!MCP_APP_DESCRIPTOR_KEYS.has(key)) continue;
    if (key === 'version' && entry === 1) mcpApp[key] = entry;
    if (key === 'connectionId' && typeof entry === 'string' && entry.length <= 64) mcpApp[key] = entry;
    if (key === 'toolName' && typeof entry === 'string' && entry.length <= 256) mcpApp[key] = entry;
    if (key === 'resourceUri' && typeof entry === 'string' && entry.length <= 4_096) mcpApp[key] = entry;
  }
  return {
    ...(Object.keys(mcpApp).length > 0 ? { mcpApp } : {}),
    result: {
      content: [{
        type: 'text',
        text: '[MCP result details exceeded the persistence limit. The complete result was not retained.]',
      }],
    },
  };
}

function preservesMcpDetails(value: unknown): value is UnknownRecord & { details: UnknownRecord } {
  return isRecord(value) && isRecord(value.details) && isRecord(value.details.mcpApp);
}

function restoreBoundedMcpDetails(original: UnknownRecord, projected: UnknownRecord): UnknownRecord {
  const restored = { ...projected };
  for (const key of ['details', 'result', 'message'] as const) {
    const source = original[key];
    const target = projected[key];
    if (key === 'details' && isRecord(source) && isRecord(source.mcpApp)) {
      restored.details = boundedMcpDetails(source);
    } else if (preservesMcpDetails(source) && isRecord(target)) {
      restored[key] = { ...target, details: boundedMcpDetails(source.details) };
    }
  }
  return restored;
}

/** Restore opaque SDK replay fields only at the assistant content boundary.
 * Never recurse into arguments/details: a tool payload can imitate these keys.
 */
function restoreAssistantSignatures(original: unknown, projected: unknown): void {
  if (!isRecord(original) || !isRecord(projected) || original.role !== 'assistant') return;
  if (!Array.isArray(original.content) || !Array.isArray(projected.content)) return;
  for (let index = 0; index < original.content.length; index += 1) {
    const source: unknown = original.content[index];
    const target: unknown = projected.content[index];
    if (!isRecord(source) || !isRecord(target) || source.type !== target.type) continue;
    const signatureKey = source.type === 'thinking' ? 'thinkingSignature'
      : source.type === 'text' ? 'textSignature'
      : source.type === 'toolCall' ? 'thoughtSignature' : null;
    if (signatureKey && typeof source[signatureKey] === 'string') {
      target[signatureKey] = source[signatureKey];
    }
  }
}

/** Removes binary image payloads and server-only resolved paths before DB writes. */
export function projectAgentMessageForPersistence(message: AgentMessage): AgentMessage {
  const original = message as unknown as UnknownRecord;
  const projected = projectVisualValue(message, 'persistence') as UnknownRecord;
  restoreAssistantSignatures(original, projected);
  return restoreBoundedMcpDetails(original, projected) as unknown as AgentMessage;
}

/** Removes binary image payloads and server-only resolved paths before client/log transport. */
export function projectAgentEventForExternal<T extends Record<string, unknown>>(event: T): T {
  const projected = projectVisualValue(event, 'external-event') as UnknownRecord;
  if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end' || event.type === 'turn_end') {
    restoreAssistantSignatures(event.message, projected.message);
  }
  if (event.type === 'agent_end' && Array.isArray(event.messages) && Array.isArray(projected.messages)) {
    event.messages.forEach((message, index) => restoreAssistantSignatures(message, (projected.messages as unknown[])[index]));
  }
  if (event.type === 'message_update' && isRecord(event.assistantMessageEvent) && isRecord(projected.assistantMessageEvent)) {
    for (const key of ['partial', 'message', 'error']) {
      restoreAssistantSignatures(event.assistantMessageEvent[key], projected.assistantMessageEvent[key]);
    }
  }
  return restoreBoundedMcpDetails(event, projected) as T;
}
