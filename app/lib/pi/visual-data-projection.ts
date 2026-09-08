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

/** Removes binary image payloads and server-only resolved paths before DB writes. */
export function projectAgentMessageForPersistence(message: AgentMessage): AgentMessage {
  return projectVisualValue(message, 'persistence') as AgentMessage;
}

/** Removes binary image payloads and server-only resolved paths before client/log transport. */
export function projectAgentEventForExternal<T extends Record<string, unknown>>(event: T): T {
  return projectVisualValue(event, 'external-event') as T;
}
