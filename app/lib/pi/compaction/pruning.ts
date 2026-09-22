/**
 * Portions adapted from NousResearch/hermes-agent at
 * e2f8a0731bf26e95b31e35d73e71e183a1045b81.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { isPiActionableUserMessage } from './selection';
import { buildPiHistoryUnits } from './units';

export const PI_SKILL_PRUNED_MARKER_PREFIX = '[SKILL_PRUNED:';

const DUPLICATE_RESULT_MIN_CHARACTERS = 200;
const DEFAULT_RESULT_MIN_CHARACTERS = 8_000;
const DEFAULT_MINIMUM_RECLAIM_TOKENS = 4_096;
const DEFAULT_PROTECTED_TAIL_MESSAGES = 20;
const DEFAULT_KEEP_NEWEST_TOOL_IMAGES = 3;
const PRESSURE_KEEP_RECENT_MESSAGES = 3;
const STALE_REPLAY_KEYS = ['codex_reasoning_items'] as const;
const LEAN_TAIL_KEEP_TOOL_ROUNDS = 6;
const LEAN_TAIL_DEMOTE_MINIMUM_CHARACTERS = 1_500;

type MessageRecord = Record<string, unknown>;

export type PiPruningReason =
  | 'disabled'
  | 'below_rearm'
  | 'no_changes'
  | 'insufficient_savings'
  | 'pruned';

export type PiPruningResult = Readonly<{
  messages: readonly AgentMessage[];
  changed: boolean;
  reason: PiPruningReason;
  prunedResultCount: number;
  duplicateResultCount: number;
  retiredImageCount: number;
  truncatedArgumentCount: number;
  staleReplayCount: number;
  beforeTokens: number;
  afterTokens: number;
  reclaimedTokens: number;
  nextRearmTokens: number | null;
}>;

export type PiLeanTailToolDemotionResult = Readonly<{
  messages: readonly AgentMessage[];
  changed: boolean;
  demotedResultCount: number;
}>;

export function createPiSkillPrunedMarker(skillName: string): string {
  const safeName = skillName.replace(/[^\p{L}\p{N}._/ -]/gu, '').trim().slice(0, 128) || 'unknown';
  return `${PI_SKILL_PRUNED_MARKER_PREFIX} content lost in compression; reload '${safeName}' by reading its SKILL.md path listed under Enabled Skills]`;
}

function asRecord(message: AgentMessage): MessageRecord {
  return message as unknown as MessageRecord;
}

function toolResultCallId(message: AgentMessage): string | null {
  if (message.role !== 'toolResult') return null;
  const value = asRecord(message).toolCallId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toolCalls(message: AgentMessage): Array<{
  id: string;
  name: string;
  arguments: unknown;
}> {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const record = part as unknown as Record<string, unknown>;
    if (record.type !== 'toolCall') return [];
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : 'unknown';
    return id ? [{ id, name: name || 'unknown', arguments: record.arguments }] : [];
  });
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const record = part as Record<string, unknown>;
    const text = typeof record.text === 'string'
      ? record.text
      : typeof record.content === 'string'
        ? record.content
        : '';
    return text ? [text] : [];
  }).join('\n');
}

function hasImageContent(content: unknown): boolean {
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      const type = (part as Record<string, unknown>).type;
      return type === 'image' || type === 'image_url' || type === 'input_image';
    });
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    return record._multimodal === true && hasImageContent(record.content);
  }
  return false;
}

function withoutStaleApiContent(record: MessageRecord): MessageRecord {
  const clone = { ...record };
  delete clone.api_content;
  return clone;
}

function stripImages(message: AgentMessage): AgentMessage | null {
  if (message.role !== 'toolResult') return null;
  const record = asRecord(message);
  const content = record.content;
  if (Array.isArray(content)) {
    let changed = false;
    const nextContent = content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const type = (part as Record<string, unknown>).type;
      if (type !== 'image' && type !== 'image_url' && type !== 'input_image') return part;
      changed = true;
      return { type: 'text', text: '[historical tool image removed to save context]' };
    });
    return changed
      ? withoutStaleApiContent({ ...record, content: nextContent }) as unknown as AgentMessage
      : null;
  }
  if (content && typeof content === 'object') {
    const envelope = content as Record<string, unknown>;
    if (envelope._multimodal !== true || !hasImageContent(envelope.content)) return null;
    const summary = typeof envelope.text_summary === 'string'
      ? envelope.text_summary.slice(0, 200)
      : 'historical tool image removed to save context';
    return withoutStaleApiContent({
      ...record,
      content: `[historical tool image removed] ${summary}`,
    }) as unknown as AgentMessage;
  }
  return null;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function skillNameFromArguments(value: unknown): string | null {
  const name = parseArguments(value).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function skillNameFromReadArguments(value: unknown): string | null {
  const filePath = parseArguments(value).path;
  if (typeof filePath !== 'string' || !/(?:^|\/)SKILL\.md$/u.test(filePath.trim())) return null;
  const parts = filePath.trim().split('/').filter(Boolean);
  return parts.length >= 2 ? parts.at(-2) ?? null : null;
}

function resultStub(input: {
  callId: string | null;
  toolName: string;
  toolArguments: unknown;
  content: string;
}): string {
  if (input.content.length > 5_000) {
    const skillName = input.toolName === 'skill_view'
      ? skillNameFromArguments(input.toolArguments)
      : input.toolName === 'read'
        ? skillNameFromReadArguments(input.toolArguments)
        : null;
    if (skillName) return createPiSkillPrunedMarker(skillName);
  }
  const digest = createHash('sha256').update(input.content).digest('hex').slice(0, 16);
  const call = input.callId ? `; call ${input.callId}` : '';
  return `[${input.toolName}] output pruned (${input.content.length.toLocaleString('en-US')} chars; sha256:${digest}${call})`;
}

function cloneToolResultWithText(message: AgentMessage, text: string): AgentMessage {
  const record = withoutStaleApiContent(asRecord(message));
  return {
    ...record,
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

function truncateArgumentValue(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.length <= 500) return { value, changed: false };
    return {
      value: `${value.slice(0, 200)}… [${value.length - 200} chars omitted from historical tool arguments]`,
      changed: true,
    };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = truncateArgumentValue(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const result = truncateArgumentValue(item);
      changed ||= result.changed;
      return [key, result.value];
    }));
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

function truncateToolCallArguments(message: AgentMessage): AgentMessage | null {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return null;
  let changed = false;
  const content = message.content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const record = part as unknown as Record<string, unknown>;
    if (record.type !== 'toolCall') return part;
    const truncated = truncateArgumentValue(record.arguments);
    if (!truncated.changed) return part;
    changed = true;
    return { ...record, arguments: truncated.value };
  });
  return changed ? { ...message, content } as AgentMessage : null;
}

function replayTokens(message: AgentMessage): number {
  const record = asRecord(message);
  return STALE_REPLAY_KEYS.reduce((total, key) => {
    const value = record[key];
    if (value === undefined || value === null) return total;
    try {
      return total + Math.ceil(JSON.stringify(value).length / 4);
    } catch {
      return total;
    }
  }, 0);
}

function estimateHistoryTokens(
  messages: readonly AgentMessage[],
  estimateMessageTokens: (message: AgentMessage) => number,
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message) + replayTokens(message),
    0,
  );
}

export function isPiLowSignalToolResult(message: AgentMessage): boolean {
  if (message.role !== 'toolResult') return false;
  const text = contentText(asRecord(message).content).trim().toLowerCase();
  if (!text) return true;
  return /^(?:ok|done|success|successful|completed|exit(?:ed)?(?: code)?[: ]*0|true|\{\s*"?(?:ok|success)"?\s*:\s*true\s*\})[.!]?$/u.test(text);
}

export function filterPiLowSignalToolRows(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !isPiLowSignalToolResult(message));
}

/**
 * Lean's compact recency tail must not be held hostage by old, large tool
 * results. This is a projection-only operation: durable history remains
 * untouched and the stub tells the model where exact content can be recovered.
 *
 * It is intentionally separate from generic pre-compaction pruning. Legacy
 * callers retain their existing pruning semantics, while Lean invokes this
 * after the atomic tail boundary is known.
 */
export function demotePiLeanTailToolResults(input: {
  messages: readonly AgentMessage[];
  tailMessages: readonly AgentMessage[];
  sessionId?: string;
  authorizedSessionId?: string | null;
  sessionSearchAvailable?: boolean;
}): PiLeanTailToolDemotionResult {
  if (input.messages.length === 0 || input.tailMessages.length === 0) {
    return Object.freeze({ messages: input.messages, changed: false, demotedResultCount: 0 });
  }
  const tailMessageSet = new Set(input.tailMessages);
  const tailIndexes = input.messages.flatMap((message, index) => (
    tailMessageSet.has(message) ? [index] : []
  ));
  if (tailIndexes.length === 0) {
    return Object.freeze({ messages: input.messages, changed: false, demotedResultCount: 0 });
  }

  const tailStart = tailIndexes[0];
  const activeToolMessages = new Set(
    buildPiHistoryUnits(input.messages)
      .filter((unit) => {
        if (unit.kind !== 'tool_group') return false;
        return !unit.toolChainComplete;
      })
      .flatMap((unit) => [...unit.messages]),
  );

  const protectedResultIndexes = new Set<number>();
  let roundsSeen = 0;
  let previousResultIndex: number | null = null;
  for (let index = input.messages.length - 1; index >= tailStart; index -= 1) {
    const message = input.messages[index];
    if (!tailMessageSet.has(message) || message.role !== 'toolResult') continue;
    if (previousResultIndex === null || previousResultIndex - index > 1) roundsSeen += 1;
    previousResultIndex = index;
    if (roundsSeen > LEAN_TAIL_KEEP_TOOL_ROUNDS) break;
    protectedResultIndexes.add(index);
  }

  const canRecover = Boolean(
    input.sessionSearchAvailable
    && input.sessionId
    && input.authorizedSessionId === input.sessionId,
  );
  const safeSessionId = canRecover
    ? input.sessionId!.replace(/[^A-Za-z0-9._:-]/gu, '').slice(0, 128)
    : '';
  const result = [...input.messages];
  let demotedResultCount = 0;
  for (let index = tailStart; index < input.messages.length; index += 1) {
    const original = input.messages[index];
    if (
      !tailMessageSet.has(original)
      || original.role !== 'toolResult'
      || protectedResultIndexes.has(index)
      || activeToolMessages.has(original)
    ) continue;
    const content = asRecord(original).content;
    if (hasImageContent(content)) continue;
    const text = contentText(content);
    if (
      text.length < LEAN_TAIL_DEMOTE_MINIMUM_CHARACTERS
      || text.startsWith(PI_SKILL_PRUNED_MARKER_PREFIX)
      || text.startsWith('[Duplicate tool output')
      || text.includes('output pruned (')
      || text.includes('output demoted at compaction')
    ) continue;
    const toolName = String(asRecord(original).toolName ?? 'tool').trim() || 'tool';
    const recoveryHint = safeSessionId
      ? ` Recover with session_search(query='<keywords>', session_id='${safeSessionId}').`
      : '';
    result[index] = cloneToolResultWithText(
      original,
      `[${toolName}] output demoted at compaction — ${text.length.toLocaleString('en-US')} chars preserved in session history.${recoveryHint}`,
    );
    demotedResultCount += 1;
  }
  return Object.freeze({
    messages: demotedResultCount > 0 ? Object.freeze(result) : input.messages,
    changed: demotedResultCount > 0,
    demotedResultCount,
  });
}

/** Deterministic, idempotent and savings-gated pruning. No LLM is involved. */
export function prunePiSessionHistory(input: {
  messages: readonly AgentMessage[];
  estimateMessageTokens: (message: AgentMessage) => number;
  enabled?: boolean;
  minimumResultCharacters?: number;
  minimumReclaimTokens?: number;
  protectLastMessages?: number;
  keepNewestToolImages?: number;
  protectedTailTokenBudget?: number | null;
  triggerTokens?: number;
  currentHistoryTokens?: number;
  rearmAtTokens?: number | null;
}): PiPruningResult {
  const beforeTokens = estimateHistoryTokens(input.messages, input.estimateMessageTokens);
  const unchanged = (reason: Exclude<PiPruningReason, 'pruned'>): PiPruningResult => Object.freeze({
    messages: input.messages,
    changed: false,
    reason,
    prunedResultCount: 0,
    duplicateResultCount: 0,
    retiredImageCount: 0,
    truncatedArgumentCount: 0,
    staleReplayCount: 0,
    beforeTokens,
    afterTokens: beforeTokens,
    reclaimedTokens: 0,
    nextRearmTokens: input.rearmAtTokens ?? null,
  });

  if (input.enabled !== true) return unchanged('disabled');
  const currentHistoryTokens = input.currentHistoryTokens ?? beforeTokens;
  if (input.rearmAtTokens !== null && input.rearmAtTokens !== undefined
    && currentHistoryTokens < input.rearmAtTokens) {
    return unchanged('below_rearm');
  }

  const result = [...input.messages];
  const protectLastMessages = Math.max(
    0,
    Math.floor(input.protectLastMessages ?? DEFAULT_PROTECTED_TAIL_MESSAGES),
  );
  const pruneBoundary = Math.max(0, result.length - protectLastMessages);
  const units = buildPiHistoryUnits(result);
  const protectedMessages = new Set<AgentMessage>(result.slice(pruneBoundary));
  const latestUserIndex = result.findLastIndex(isPiActionableUserMessage);
  const activeToolUnits = units.filter((unit) => {
    if (unit.kind !== 'tool_group') return false;
    const firstIndex = result.indexOf(unit.messages[0]);
    return !unit.toolChainComplete || (latestUserIndex >= 0 && firstIndex > latestUserIndex);
  });
  const activeToolMessages = new Set(activeToolUnits.flatMap((unit) => [...unit.messages]));
  for (const unit of activeToolUnits) {
    for (const message of unit.messages) protectedMessages.add(message);
  }

  const callIndex = new Map<string, { name: string; arguments: unknown }>();
  for (const message of result) {
    for (const call of toolCalls(message)) {
      callIndex.set(call.id, { name: call.name, arguments: call.arguments });
    }
  }

  let duplicateResultCount = 0;
  const hashes = new Set<string>();
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    if (message.role !== 'toolResult') continue;
    const content = asRecord(message).content;
    if (hasImageContent(content)) continue;
    const text = contentText(content);
    if (text.length < DUPLICATE_RESULT_MIN_CHARACTERS) continue;
    const digest = createHash('sha256').update(text).digest('hex');
    if (hashes.has(digest) && !protectedMessages.has(message)) {
      result[index] = cloneToolResultWithText(
        message,
        '[Duplicate tool output — same content as a more recent call]',
      );
      duplicateResultCount += 1;
    } else {
      hashes.add(digest);
    }
  }

  let prunedResultCount = 0;
  const minimumResultCharacters = Math.max(
    DUPLICATE_RESULT_MIN_CHARACTERS,
    Math.floor(input.minimumResultCharacters ?? DEFAULT_RESULT_MIN_CHARACTERS),
  );
  const demoteAt = (index: number, allowProtected: boolean): boolean => {
    const message = result[index];
    if (message.role !== 'toolResult') return false;
    if (!allowProtected && protectedMessages.has(input.messages[index])) return false;
    const content = asRecord(message).content;
    if (hasImageContent(content)) return false;
    const text = contentText(content);
    if (text.length <= minimumResultCharacters
      || text.startsWith(PI_SKILL_PRUNED_MARKER_PREFIX)
      || text.startsWith('[Duplicate tool output')
      || text.includes('output pruned (')) return false;
    const callId = toolResultCallId(message);
    const call = callId ? callIndex.get(callId) : undefined;
    result[index] = cloneToolResultWithText(message, resultStub({
      callId,
      toolName: call?.name ?? String(asRecord(message).toolName ?? 'unknown'),
      toolArguments: call?.arguments,
      content: text,
    }));
    prunedResultCount += 1;
    return true;
  };

  for (let index = 0; index < pruneBoundary; index += 1) demoteAt(index, false);

  let truncatedArgumentCount = 0;
  for (let index = 0; index < pruneBoundary; index += 1) {
    const original = input.messages[index];
    if (protectedMessages.has(original)) continue;
    const truncated = truncateToolCallArguments(result[index]);
    if (!truncated) continue;
    result[index] = truncated;
    truncatedArgumentCount += 1;
  }

  let retiredImageCount = 0;
  let imageCount = 0;
  const keepNewestToolImages = Math.max(
    0,
    Math.floor(input.keepNewestToolImages ?? DEFAULT_KEEP_NEWEST_TOOL_IMAGES),
  );
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const original = input.messages[index];
    if (original.role !== 'toolResult' || !hasImageContent(asRecord(result[index]).content)) continue;
    imageCount += 1;
    if (
      imageCount <= keepNewestToolImages
      || activeToolMessages.has(original)
      || index >= result.length - PRESSURE_KEEP_RECENT_MESSAGES
    ) continue;
    const stripped = stripImages(result[index]);
    if (!stripped) continue;
    result[index] = stripped;
    retiredImageCount += 1;
  }

  let staleReplayCount = 0;
  const newestAssistantIndex = result.findLastIndex((message) => message.role === 'assistant');
  for (let index = 0; index < newestAssistantIndex; index += 1) {
    const original = input.messages[index];
    if (
      original.role !== 'assistant'
      || activeToolMessages.has(original)
      || index >= result.length - PRESSURE_KEEP_RECENT_MESSAGES
    ) continue;
    const record = asRecord(result[index]);
    if (!STALE_REPLAY_KEYS.some((key) => record[key] !== undefined)) continue;
    const clone = { ...record };
    for (const key of STALE_REPLAY_KEYS) delete clone[key];
    result[index] = clone as unknown as AgentMessage;
    staleReplayCount += 1;
  }

  const protectedTailTokenBudget = input.protectedTailTokenBudget ?? null;
  if (protectedTailTokenBudget !== null && protectedTailTokenBudget > 0) {
    const softCeiling = Math.floor(protectedTailTokenBudget * 1.5);
    const recentStart = Math.max(pruneBoundary, result.length - PRESSURE_KEEP_RECENT_MESSAGES);
    const protectedTokens = () => estimateHistoryTokens(
      result.slice(pruneBoundary),
      input.estimateMessageTokens,
    );
    for (let index = pruneBoundary; index < recentStart && protectedTokens() > softCeiling; index += 1) {
      const original = input.messages[index];
      if (activeToolMessages.has(original)) continue;
      demoteAt(index, true);
      const truncated = truncateToolCallArguments(result[index]);
      if (truncated) {
        result[index] = truncated;
        truncatedArgumentCount += 1;
      }
    }
  }

  const changedCount = prunedResultCount
    + duplicateResultCount
    + retiredImageCount
    + truncatedArgumentCount
    + staleReplayCount;
  if (changedCount === 0) return unchanged('no_changes');
  const afterTokens = estimateHistoryTokens(result, input.estimateMessageTokens);
  const reclaimedTokens = Math.max(0, beforeTokens - afterTokens);
  const minimumReclaimTokens = Math.max(
    0,
    Math.floor(input.minimumReclaimTokens ?? DEFAULT_MINIMUM_RECLAIM_TOKENS),
  );
  if (reclaimedTokens < minimumReclaimTokens) return unchanged('insufficient_savings');
  const runway = Math.max(
    reclaimedTokens,
    Math.max(0, Math.floor(input.triggerTokens ?? 0)),
    minimumReclaimTokens,
  );

  return Object.freeze({
    messages: Object.freeze(result),
    changed: true,
    reason: 'pruned',
    prunedResultCount,
    duplicateResultCount,
    retiredImageCount,
    truncatedArgumentCount,
    staleReplayCount,
    beforeTokens,
    afterTokens,
    reclaimedTokens,
    nextRearmTokens: afterTokens + runway,
  });
}
