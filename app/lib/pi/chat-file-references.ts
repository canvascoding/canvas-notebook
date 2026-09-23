import 'server-only';
import path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from './agent-execution-context';
import { extractLegacyToolFileReferences, MAX_CHAT_FILE_REFERENCES, normalizeReferenceWorkspacePath, parseChatFileReferences } from '@/app/lib/chat/tool-file-references';

/** Capture trusted tool receipts before output budgeting and host-path redaction. */
export function attachChatFileReferences<T extends AgentToolResult<unknown>>(
  result: T, toolName: string, toolCallId: string, context: Pick<AgentExecutionContext, 'workspaceId' | 'workspaceRoot'>,
): T {
  if (!result.details || typeof result.details !== 'object' || Array.isArray(result.details)) return result;
  const { chatFileReferences: _untrusted, ...details } = result.details as Record<string, unknown>;
  const normalizePath = (value: unknown) => {
    if (typeof value !== 'string') return null;
    let candidate = value;
    // This legacy alias is defined by the file tools as the active workspace.
    if (candidate.startsWith('/data/workspace/')) candidate = candidate.slice('/data/workspace/'.length);
    else if (path.isAbsolute(candidate)) {
      const relative = path.relative(context.workspaceRoot, candidate);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
      candidate = relative;
    }
    return normalizeReferenceWorkspacePath(candidate.replace(/^\.\//u, ''));
  };
  // Prefer the resolved result path when available, including Studio reads whose
  // display path would otherwise look like an ordinary workspace path.
  const referenceDetails = toolName === 'read' && typeof details.resolvedPath === 'string'
    ? { ...details, filePath: normalizePath(details.resolvedPath), source: 'workspace' } : details;
  const references = (result as T & { isError?: boolean }).isError ? [] : extractLegacyToolFileReferences({
    details: referenceDetails, toolName, toolCallId, workspaceId: context.workspaceId, normalizePath,
  });
  const unique = [...new Map(references.map(entry => [`${entry.path}\0${entry.kind}`, entry])).values()];
  const chatFileReferences = parseChatFileReferences({ version: 1, references: unique.slice(0, MAX_CHAT_FILE_REFERENCES),
    ...(unique.length > MAX_CHAT_FILE_REFERENCES ? { omittedCount: unique.length - MAX_CHAT_FILE_REFERENCES } : {}) });
  return { ...result, details: { ...details, ...(chatFileReferences?.references.length ? { chatFileReferences } : {}) } };
}
