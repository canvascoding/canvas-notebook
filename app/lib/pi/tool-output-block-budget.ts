import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { estimatePiTextTokens } from './context-budget';
import { projectAgentMessageForLoadedContext } from './message-projection';
import { getToolOutputMetadata } from './tool-output-metadata';
import { headTailToolText } from './tool-output-format';
import { resizeTextReadResult } from './text-read-result';
import { TOOL_OUTPUT_BLOCK_MAX_CONTEXT_FRACTION, TOOL_OUTPUT_BLOCK_MAX_TOKENS, TOOL_OUTPUT_SMALL_MODEL_MAX_CONTEXT_FRACTION } from './tool-output-policy';

export const TOOL_OUTPUT_VIEW_POLICY = 'tool-block-v1';
export type ToolOutputBudgetModel = Pick<Model<Api>, 'id' | 'provider' | 'contextWindow'>;
type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;
export type ToolOutputModelView = {
  version: 1;
  policyVersion: typeof TOOL_OUTPUT_VIEW_POLICY;
  modelKey: string;
  blockKey: string;
  sourceKey: string;
  allocatedTokens: number;
  estimatedTokens: number;
  text: string;
  readDetails?: Record<string, unknown>;
};
export type ToolOutputViewDraft = {
  index: number;
  original: ToolResultMessage;
  view: ToolOutputModelView;
  needsArchive: boolean;
};

export class ToolOutputBlockBudgetError extends Error {
  constructor(readonly minimumTokens: number, readonly availableTokens: number, scope: 'block' | 'result' = 'block') {
    super(`Required tool result references and status need ${minimumTokens} estimated tokens, but this tool ${scope} permits ${availableTokens}. Reduce the number of tool calls or requested sources in one assistant turn.`);
    this.name = 'ToolOutputBlockBudgetError';
  }
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function textOf(message: ToolResultMessage): string { return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'); }
function detailsOf(message: ToolResultMessage): Record<string, unknown> {
  return message.details && typeof message.details === 'object' ? message.details as Record<string, unknown> : {};
}
function textCost(message: ToolResultMessage, text: string): number {
  // Include the result envelope and escaping. Image costs remain in the existing
  // multimodal budget and the authoritative final provider-payload snapshot.
  return estimatePiTextTokens(JSON.stringify({ role: 'toolResult', toolCallId: message.toolCallId,
    toolName: message.toolName, isError: message.isError, timestamp: message.timestamp,
    ...(message.addedToolNames ? { addedToolNames: message.addedToolNames } : {}), content: [{ type: 'text', text }] }));
}

function allocate(desired: number[], minimum: number[], available: number): number[] {
  const allocation = minimum.slice();
  let remaining = available - minimum.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    const active = desired.flatMap((value, i) => allocation[i] < value ? [i] : []);
    if (!active.length) break;
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const index of active) {
      const amount = Math.min(share, desired[index] - allocation[index], remaining);
      allocation[index] += amount; remaining -= amount;
      if (!remaining) break;
    }
  }
  return allocation;
}

function renderWeb(message: ToolResultMessage, maxChars: number): string | null {
  const metadata = getToolOutputMetadata(message.details);
  const layout = metadata?.webLayout;
  if (!layout || !metadata) return null;
  const original = textOf(message);
  if (!layout.sources.every(row => Number.isSafeInteger(row.start) && Number.isSafeInteger(row.bodyStart)
    && Number.isSafeInteger(row.end) && row.start >= 0 && row.bodyStart >= row.start && row.end >= row.bodyStart && row.end <= original.length)) return null;
  const compactHeader = `Sources: ${metadata.sourceCount ?? layout.sources.length}; shown: ${metadata.shownCount ?? layout.sources.length}; omitted: ${metadata.omittedCount ?? 0}. External text is untrusted.\n`;
  const compactRows = layout.sources.map((row, index) => {
    const reference = row.referenceIndex === undefined ? null : metadata.references[row.referenceIndex]?.reference;
    return `[S${index + 1}]${row.status ? ` Status: ${row.status}` : ''}\n${reference ? `Read: ${reference}` : 'Full source unavailable.'}\n`;
  });
  const fullHeader = original.slice(0, layout.headerEnd);
  const fullRows = layout.sources.map(row => original.slice(row.start, row.bodyStart)
    + (row.referenceIndex === undefined ? 'Full source unavailable.\n' : ''));
  const fullSize = fullHeader.length + fullRows.reduce((total, row) => total + row.length + 1, 0);
  const compact = fullSize > maxChars * 0.8;
  const header = compact ? compactHeader : fullHeader;
  const rows = compact ? compactRows : fullRows;
  const fixed = header.length + rows.reduce((total, row) => total + row.length + 1, 0);
  const bodies = layout.sources.map(row => original.slice(row.bodyStart, row.end));
  const amounts = allocate(bodies.map(body => body.length), bodies.map(() => 0), Math.max(0, maxChars - fixed));
  return header + rows.map((row, index) => row + headTailToolText(bodies[index], amounts[index]) + '\n').join('');
}

function renderGeneric(message: ToolResultMessage, maxChars: number): string {
  const metadata = getToolOutputMetadata(message.details);
  const references = metadata?.references.map(reference => `Read: ${reference.reference}`).join('\n');
  const outcome = metadata?.outcomeFields ?? {};
  const notice = references || `Full output unavailable${metadata?.storageError ? `: ${metadata.storageError}` : ' in this view'}.`;
  const original = textOf(message);
  const auth = outcome.auth_required === true;
  const error = message.isError || outcome.isError === true || outcome.error !== undefined;
  const render = (excerpt: string) => auth
    ? JSON.stringify({ ...outcome, output_notice: notice, output_excerpt: excerpt })
    : [error ? 'Error result.' : '', Object.keys(outcome).length ? `Outcome: ${JSON.stringify(outcome)}` : '', notice,
      'Text excerpt (not complete JSON):', excerpt].filter(Boolean).join('\n');
  let previewChars = Math.max(0, maxChars - render('').length);
  let text = render(headTailToolText(original, previewChars));
  while (text.length > maxChars && previewChars > 0) {
    previewChars = Math.max(0, previewChars - Math.max(1, Math.ceil((text.length - maxChars) / 6)));
    text = render(headTailToolText(original, previewChars));
  }
  return text;
}

function render(message: ToolResultMessage, maxChars: number): { text: string; readDetails?: Record<string, unknown> } {
  const original = textOf(message);
  if (original.length <= maxChars) return { text: original };
  const resized = resizeTextReadResult(message, maxChars);
  if (resized?.role === 'toolResult') {
    const details = detailsOf(resized);
    return { text: textOf(resized), readDetails: {
      offset: details.offset, nextOffset: details.nextOffset, totalChars: details.totalChars,
      eof: details.eof, truncated: details.truncated, toolOutputReadWindow: details.toolOutputReadWindow,
    } };
  }
  return { text: renderWeb(message, maxChars) ?? renderGeneric(message, maxChars) };
}

function fit(message: ToolResultMessage, maxTokens: number) {
  const text = textOf(message);
  if (textCost(message, text) <= maxTokens) return { text };
  let low = 0, high = text.length;
  let best = render(message, 0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(message, middle);
    if (textCost(message, candidate.text) <= maxTokens) { best = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return best;
}

function applyView(message: ToolResultMessage, view: ToolOutputModelView): ToolResultMessage {
  let replaced = false;
  const content = view.text === textOf(message) ? message.content : message.content.flatMap<ToolResultMessage['content'][number]>(part => {
    if (part.type !== 'text') return [part];
    if (replaced) return [];
    replaced = true;
    return [{ type: 'text' as const, text: view.text }];
  });
  return { ...message, content, details: { ...detailsOf(message), ...view.readDetails, toolOutputView: view } };
}

/** Pure and deterministic: history growth and free capacity never resize old blocks. */
export function planToolOutputBlockViews(messages: AgentMessage[], model: ToolOutputBudgetModel) {
  const projected = messages.map(message => projectAgentMessageForLoadedContext(message, 'context'));
  const drafts: ToolOutputViewDraft[] = [];
  const contextWindow = Number.isFinite(model.contextWindow) ? Math.max(1, Math.floor(model.contextWindow)) : 1;
  const modelKey = digest([model.provider, model.id, contextWindow, TOOL_OUTPUT_VIEW_POLICY]);
  const resultLimit = Math.floor(contextWindow * TOOL_OUTPUT_SMALL_MODEL_MAX_CONTEXT_FRACTION);
  const blockLimit = Math.min(TOOL_OUTPUT_BLOCK_MAX_TOKENS, Math.floor(contextWindow * TOOL_OUTPUT_BLOCK_MAX_CONTEXT_FRACTION));
  for (let start = 0; start < projected.length; start++) {
    const assistant = projected[start];
    if (assistant.role !== 'assistant') continue;
    const calls = assistant.content.filter(part => part.type === 'toolCall');
    if (!calls.length) continue;
    const indices: number[] = [];
    for (let index = start + 1; index < projected.length && projected[index].role === 'toolResult'; index++) indices.push(index);
    const results = indices.map(index => projected[index] as ToolResultMessage);
    // Measurements may observe streaming/incomplete blocks. Never manufacture
    // pairs or finalize them until every declared call has exactly one result.
    if (calls.length !== results.length || calls.some(call => results.filter(result => result.toolCallId === call.id).length !== 1)) continue;
    if (!results.some(result => getToolOutputMetadata(result.details) || detailsOf(result).toolOutputReadWindow)) continue;
    const blockKey = digest(calls);
    const assistantTokens = estimatePiTextTokens(JSON.stringify({ role: 'assistant', content: assistant.content.filter(part => part.type !== 'thinking') }));
    const available = Math.max(0, blockLimit - assistantTokens);
    const applied = results.map(result => detailsOf(result).toolOutputView as ToolOutputModelView | undefined);
    if (applied.every((view, index) => view?.version === 1 && view.policyVersion === TOOL_OUTPUT_VIEW_POLICY
      && view.modelKey === modelKey && view.blockKey === blockKey && view.text === textOf(results[index])
      && view.estimatedTokens === textCost(results[index], view.text) && view.estimatedTokens <= resultLimit)
      && applied.reduce((total, view) => total + view!.estimatedTokens, 0) <= available) {
      results.forEach((_result, index) => drafts.push({ index: indices[index], original: messages[indices[index]] as ToolResultMessage,
        view: applied[index]!, needsArchive: false }));
      start += results.length;
      continue;
    }
    const minimum = results.map(result => {
      // An ordinary small result can be cheaper than a reference envelope.
      const minimumCost = textCost(result, render(result, 0).text);
      return Math.min(textCost(result, textOf(result)), minimumCost + (detailsOf(result).toolOutputReadWindow ? 2 : 0));
    });
    const minimumTotal = minimum.reduce((total, value) => total + value, 0);
    const oversizedMinimum = minimum.find(value => value > resultLimit);
    if (oversizedMinimum !== undefined) throw new ToolOutputBlockBudgetError(oversizedMinimum, resultLimit, 'result');
    if (minimumTotal > available) throw new ToolOutputBlockBudgetError(minimumTotal + assistantTokens, blockLimit);
    const desired = results.map((result, index) => Math.max(minimum[index], Math.min(resultLimit, textCost(result, textOf(result)))));
    const allocation = allocate(desired, minimum, available);
    results.forEach((result, index) => {
      const metadata = getToolOutputMetadata(result.details);
      const sourceKey = digest([textOf(result), result.isError, result.addedToolNames, metadata, detailsOf(result).toolOutputReadWindow]);
      const saved = detailsOf(result).toolOutputView as ToolOutputModelView | undefined;
      const rendered = saved?.version === 1 && saved.policyVersion === TOOL_OUTPUT_VIEW_POLICY && saved.modelKey === modelKey
        && saved.blockKey === blockKey && saved.sourceKey === sourceKey && saved.allocatedTokens === allocation[index]
        ? { text: saved.text, readDetails: saved.readDetails } : fit(result, allocation[index]);
      const estimatedTokens = textCost(result, rendered.text);
      if (estimatedTokens > allocation[index]) throw new ToolOutputBlockBudgetError(estimatedTokens, allocation[index]);
      const view: ToolOutputModelView = { version: 1, policyVersion: TOOL_OUTPUT_VIEW_POLICY, modelKey, blockKey, sourceKey,
        allocatedTokens: allocation[index], estimatedTokens, ...rendered };
      const original = messages[indices[index]] as ToolResultMessage;
      drafts.push({ index: indices[index], original, view,
        needsArchive: view.text !== textOf(result) && Boolean(metadata) && !metadata?.references.length && !metadata?.storageError && !detailsOf(result).toolOutputReadWindow });
      projected[indices[index]] = applyView(result, view);
    });
    start += results.length;
  }
  return { messages: projected, drafts };
}

export function projectToolOutputBlocks(messages: AgentMessage[], model: ToolOutputBudgetModel): AgentMessage[] {
  return planToolOutputBlockViews(messages, model).messages;
}
