import type { ChatMessage } from './types';
import { stripInternalProjectionNotices } from './display-text';
import { extractLegacyToolFileReferences, readChatFileReferences, type ChatFileReference } from './tool-file-references';
import { parseFileChangeGroupV1 } from '@/app/lib/file-version-center/contracts/v1';
import { FILE_CHANGE_APP_URI, readBuiltinToolAppMessages, type BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';

export type RunFileReferences = {
  key: string;
  references: ChatFileReference[];
  omittedCount: number;
  changeApps: BuiltinToolAppDescriptor[];
  changeReferences: ChatFileReference[];
};
const supportedTools = new Set(['read', 'write', 'edit_file', 'apply_patch']);
const inProgress = new Set(['pending', 'sending', 'aborting']);

/** User messages delimit runs, as in buildToolBatchProjection. No prose scanning. */
export function buildRunFileReferenceProjection(
  messages: ChatMessage[],
  workspaceId: string | null | undefined,
  activeRunInProgress = false,
): Map<string, RunFileReferences> {
  const groups = new Map<string, RunFileReferences>();
  if (!workspaceId) return groups;
  let segmentStart = 0;
  const project = (end: number) => {
    if (end === messages.length && activeRunInProgress) return;
    const segment = messages.slice(segmentStart, end);
    if (segment.some(message => message.role === 'assistant' && inProgress.has(message.status ?? ''))) return;
    // Last receipt for a repeated tool call wins, preserving original call order.
    const tools = new Map<string, ChatMessage>();
    for (const message of segment) {
      if (message.role === 'toolResult' && message.toolCallId) tools.set(message.toolCallId, message);
    }
    const byPath = new Map<string, ChatFileReference>();
    const changeApps = new Map<string, BuiltinToolAppDescriptor>();
    const changeReferences: ChatFileReference[] = [];
    let omittedCount = 0;
    for (const [toolCallId, message] of tools) {
      const record = message.piMessage as { details?: unknown; isError?: boolean; toolName?: string } | undefined;
      const toolName = message.toolName || record?.toolName || '';
      const details = record?.details as { error?: unknown } | undefined;
      if (message.status === 'error' || inProgress.has(message.status ?? '') || message.type === 'tool_use'
        || record?.isError || details?.error || !supportedTools.has(toolName)) continue;
      const envelope = readChatFileReferences(record?.details);
      const references: ChatFileReference[] = [...(envelope?.references ?? extractLegacyToolFileReferences({
        toolName, toolCallId, details: record?.details, workspaceId,
      }))];
      // Preserve real per-tool bindings; the summary reads their current state
      // together without manufacturing a synthetic tool call or change group.
      for (const app of readBuiltinToolAppMessages(message.piMessage)) {
        if (app.resourceUri !== FILE_CHANGE_APP_URI || app.toolCallId !== toolCallId) continue;
        const group = parseFileChangeGroupV1((record?.details as { changeGroup: unknown }).changeGroup);
        if (group.workspaceId !== workspaceId) continue;
        changeApps.set(`${app.toolCallId}:${app.entityId}`, app);
        for (const entry of group.entries) {
          if (entry.outcome === 'failed') continue;
          const existingReference = references.find(reference => reference.path === entry.pathHint
            && reference.workspaceId === workspaceId && reference.toolCallId === toolCallId);
          const reference: ChatFileReference = existingReference ?? {
            workspaceId, toolCallId, path: entry.pathHint,
            kind: entry.outcome === 'review_required' || entry.outcome === 'conflict' ? 'review_required' : 'changed',
          };
          // Keep every receipt's path for partial reads; a missing earlier
          // proposal must not be hidden by a later available applied edit.
          changeReferences.push(reference);
          if (!existingReference) references.push(reference);
        }
      }
      if (envelope && references.some(ref => ref.workspaceId === workspaceId && ref.toolCallId === toolCallId)) {
        omittedCount += envelope.omittedCount ?? 0;
      }
      for (const reference of references) {
        if (reference.workspaceId !== workspaceId || reference.toolCallId !== toolCallId) continue;
        const existing = byPath.get(reference.path);
        // Later reads/no-op writes must not obscure the actual output operation.
        if (existing && (reference.kind === 'read' || reference.kind === 'unchanged')) continue;
        const kind = existing?.kind === 'review_required' ? 'review_required'
          : existing?.kind === 'created' && reference.kind === 'changed' ? 'created' : reference.kind;
        byPath.set(reference.path, { ...reference, kind });
      }
    }
    if (!byPath.size) return;
    // Put the one section after the last visible answer or completed tool result.
    // This also retains files when a run ends without a final assistant answer.
    const anchor = segment.findLast(message => (
      (message.role === 'assistant' && stripInternalProjectionNotices(message.content).trim().length > 0)
      || message.role === 'toolResult'
    ));
    if (!anchor) return;
    groups.set(anchor.id, {
      // The tail call survives DB message IDs and loading the beginning of a run.
      key: `${workspaceId}:${[...tools.keys()].at(-1)}`,
      references: [...byPath.values()], omittedCount, changeApps: [...changeApps.values()], changeReferences,
    });
  };
  for (let index = 0; index <= messages.length; index += 1) {
    if (index < messages.length) {
      const message = messages[index];
      // Composer placeholders are not new runtime turns. In particular a
      // queued steering message must not flush the still-running response.
      if (message.role !== 'user' || (message.status !== undefined && message.status !== 'sent')) continue;
    }
    project(index);
    segmentStart = index + 1;
  }
  return groups;
}
