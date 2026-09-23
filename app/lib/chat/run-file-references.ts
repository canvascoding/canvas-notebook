import type { ChatMessage } from './types';
import { stripInternalProjectionNotices } from './display-text';
import { extractLegacyToolFileReferences, readChatFileReferences, type ChatFileReference } from './tool-file-references';

export type RunFileReferences = { key: string; references: ChatFileReference[]; omittedCount: number };
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
    let omittedCount = 0;
    for (const [toolCallId, message] of tools) {
      const record = message.piMessage as { details?: unknown; isError?: boolean; toolName?: string } | undefined;
      const toolName = message.toolName || record?.toolName || '';
      const details = record?.details as { error?: unknown } | undefined;
      if (message.status === 'error' || inProgress.has(message.status ?? '') || message.type === 'tool_use'
        || record?.isError || details?.error || !supportedTools.has(toolName)) continue;
      const envelope = readChatFileReferences(record?.details);
      const references: ChatFileReference[] = envelope?.references ?? extractLegacyToolFileReferences({
        toolName, toolCallId, details: record?.details, workspaceId,
      });
      if (envelope && references.some(ref => ref.workspaceId === workspaceId && ref.toolCallId === toolCallId)) {
        omittedCount += envelope.omittedCount ?? 0;
      }
      for (const reference of references) {
        if (reference.workspaceId !== workspaceId || reference.toolCallId !== toolCallId) continue;
        const existing = byPath.get(reference.path);
        // Later reads/no-op writes must not obscure the actual output operation.
        if (existing && (reference.kind === 'read' || reference.kind === 'unchanged')) continue;
        const kind = existing?.kind === 'created' && reference.kind === 'changed' ? 'created' : reference.kind;
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
      references: [...byPath.values()], omittedCount,
    });
  };
  for (let index = 0; index <= messages.length; index += 1) {
    if (index < messages.length && messages[index].role !== 'user') continue;
    project(index);
    segmentStart = index + 1;
  }
  return groups;
}
