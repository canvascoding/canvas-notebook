/** Bounded UI receipts, created from completed tools, never from assistant prose. */
export type ChatFileReferenceKind = 'read' | 'created' | 'changed' | 'review_required' | 'unchanged';
export type ChatFileReference = {
  workspaceId: string;
  path: string;
  kind: ChatFileReferenceKind;
  toolCallId: string;
};
export type ChatFileReferences = { version: 1; references: ChatFileReference[]; omittedCount?: number };
export const MAX_CHAT_FILE_REFERENCES = 500;
const kinds = new Set<ChatFileReferenceKind>(['read', 'created', 'changed', 'review_required', 'unchanged']);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeReferenceWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return normalized;
}

/** Reconstruct allowed fields so generic projection bypasses cannot carry extra data. */
export function parseChatFileReferences(value: unknown): ChatFileReferences | null {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.references)
    || value.references.length > MAX_CHAT_FILE_REFERENCES) return null;
  if (value.omittedCount !== undefined && (!Number.isSafeInteger(value.omittedCount) || Number(value.omittedCount) < 0)) return null;
  const references: ChatFileReference[] = [];
  for (const entry of value.references) {
    if (!record(entry) || typeof entry.workspaceId !== 'string' || !entry.workspaceId || entry.workspaceId.length > 256
      || typeof entry.toolCallId !== 'string' || !entry.toolCallId || entry.toolCallId.length > 256
      || /[\s/\\\u0000-\u001f\u007f]/u.test(entry.workspaceId) || /[\s/\\\u0000-\u001f\u007f]/u.test(entry.toolCallId)
      || !kinds.has(entry.kind as ChatFileReferenceKind)) return null;
    const path = normalizeReferenceWorkspacePath(entry.path);
    if (!path) return null;
    references.push({ workspaceId: entry.workspaceId, path, kind: entry.kind as ChatFileReferenceKind, toolCallId: entry.toolCallId });
  }
  return { version: 1, references, ...(value.omittedCount ? { omittedCount: Number(value.omittedCount) } : {}) };
}

export function readChatFileReferences(details: unknown): ChatFileReferences | null {
  return record(details) ? parseChatFileReferences(details.chatFileReferences) : null;
}

export function extractLegacyToolFileReferences(input: {
  toolName: string; toolCallId: string; details: unknown; workspaceId: string;
  normalizePath?: (path: unknown) => string | null;
}): ChatFileReference[] {
  const details = input.details;
  if (!record(details) || details.error || details.isError === true) return [];
  const normalize = input.normalizePath ?? normalizeReferenceWorkspacePath;
  const references: ChatFileReference[] = [];
  const add = (value: unknown, kind: ChatFileReferenceKind) => {
    const path = normalize(value);
    if (path) references.push({ workspaceId: input.workspaceId, toolCallId: input.toolCallId, path, kind });
  };
  const mutation = (value: unknown) => {
    if (!record(value) || value.kind !== 'file_mutation' || value.contractVersion !== 1 || value.error) return;
    if (value.outcome === 'review_required') add(value.path, 'review_required');
    else if (value.outcome === 'unchanged') add(value.path, 'unchanged');
    else if (value.outcome === 'applied' && value.changed === true) {
      add(value.path, value.beforeSha256 === null ? 'created' : 'changed');
    }
  };
  if (input.toolName === 'read') {
    if (!details.toolOutputRead && details.source !== 'studio' && details.source !== 'absolute' && ['text', 'image', 'pdf', 'collaboration_structure'].includes(String(details.type))) add(details.filePath, 'read');
  } else if (input.toolName === 'write' || input.toolName === 'edit_file') mutation(details);
  else if (input.toolName === 'apply_patch' && details.kind === 'file_patch_batch' && Array.isArray(details.results)) {
    details.results.forEach(mutation);
  }
  return references;
}
