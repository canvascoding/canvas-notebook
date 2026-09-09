import 'server-only';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getToolOutputMetadata } from './tool-output-metadata';
import { ToolOutputBlockBudgetError, planToolOutputBlockViews, type ToolOutputBudgetModel, type ToolOutputViewDraft } from './tool-output-block-budget';
import { storeToolOutput, type ToolOutputIdentity } from './tool-output-store';

// Persistence and the next-turn hook can meet at the same completed result.
// Share that write; do not create duplicate artifacts under concurrent callbacks.
const pendingArchives = new WeakMap<object, Promise<void>>();

async function archiveDraft(draft: ToolOutputViewDraft, identity: ToolOutputIdentity | null): Promise<void> {
  const message = draft.original;
  const pending = pendingArchives.get(message);
  if (pending) return pending;
  const operation = (async () => {
    const metadata = getToolOutputMetadata(message.details);
    if (!metadata || metadata.references.length || metadata.storageError) return;
    const details = { ...(message.details as Record<string, unknown>) };
    delete details.toolOutput; delete details.toolOutputView;
    const stored = identity ? await storeToolOutput({
      identity, toolCallId: message.toolCallId, format: 'json',
      content: JSON.stringify({ content: message.content, details, isError: message.isError }),
    }) : { ok: false as const, error: 'No active session; full output is unavailable.' };
    const nextMetadata = { ...metadata, references: metadata.references.slice() };
    if (stored.ok) {
      const { reference, manifestReference, bytes, characters, sha256, complete } = stored;
      nextMetadata.references.push({ reference, manifestReference, bytes, characters, sha256, complete });
      nextMetadata.storedBytes += bytes;
    } else nextMetadata.storageError = stored.error;
    message.details = { ...(message.details as Record<string, unknown>), toolOutput: nextMetadata };
  })();
  pendingArchives.set(message, operation);
  try { await operation; } finally { pendingArchives.delete(message); }
}

/** Write boundary only. Display measurements call the pure projection instead. */
export async function finalizeToolOutputBlocks(messages: AgentMessage[], model: ToolOutputBudgetModel, identity: ToolOutputIdentity | null) {
  const initial = planToolOutputBlockViews(messages, model);
  for (const draft of initial.drafts) if (draft.needsArchive) await archiveDraft(draft, identity);
  const finalized = initial.drafts.some(draft => draft.needsArchive) ? planToolOutputBlockViews(messages, model) : initial;
  let changed = 0;
  for (const draft of finalized.drafts) {
    const previous = (draft.original.details as { toolOutputView?: { sourceKey?: string; modelKey?: string } } | undefined)?.toolOutputView;
    if (previous?.sourceKey !== draft.view.sourceKey || previous?.modelKey !== draft.view.modelKey) changed++;
    draft.original.details = { ...(draft.original.details as Record<string, unknown>), toolOutputView: draft.view };
  }
  if (changed) {
    const outputs = finalized.drafts.map(draft => getToolOutputMetadata(draft.original.details));
    console.info('[ToolOutput] finalized views', {
      policyVersion: finalized.drafts[0].view.policyVersion, contextWindow: model.contextWindow, changed,
      rawChars: outputs.reduce((total, output) => total + (output?.rawChars ?? 0), 0),
      modelChars: finalized.drafts.reduce((total, draft) => total + draft.view.text.length, 0),
      storedBytes: outputs.reduce((total, output) => total + (output?.storedBytes ?? 0), 0),
      shownSources: outputs.reduce((total, output) => total + (output?.shownCount ?? 0), 0),
      omittedSources: outputs.reduce((total, output) => total + (output?.omittedCount ?? 0), 0),
    });
  }
  return finalized.messages;
}

/** Even an unsendable block must remain in the transcript for inspection. */
export async function finalizeToolOutputBlocksForPersistence(messages: AgentMessage[], model: ToolOutputBudgetModel, identity: ToolOutputIdentity | null): Promise<void> {
  try { await finalizeToolOutputBlocks(messages, model, identity); } catch (error) {
    if (!(error instanceof ToolOutputBlockBudgetError)) throw error;
    console.warn('[ToolOutput] block cannot fit model budget', { minimumTokens: error.minimumTokens, availableTokens: error.availableTokens });
  }
}
