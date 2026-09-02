/**
 * Portions adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { PiHistoryUnit } from './units';

const MAX_TAIL_MESSAGE_FLOOR = 8;
const MINIMUM_TAIL_MESSAGES = 3;
const TAIL_SOFT_CEILING_RATIO = 1.5;

export type PiCompactionSelection = Readonly<{
  headUnits: readonly PiHistoryUnit[];
  middleUnits: readonly PiHistoryUnit[];
  tailUnits: readonly PiHistoryUnit[];
  keptUnits: readonly PiHistoryUnit[];
  effectiveProtectFirstMessages: number;
  minimumTailMessages: number;
  headTokens: number;
  tailTokens: number;
  keptTokens: number;
  keptBytes: number;
  minimumRequiredTokens: number;
  minimumRequiredBytes: number;
  activeUserAnchored: boolean;
  visibleAssistantAnchored: boolean;
}>;

type MeasureUnit = (unit: PiHistoryUnit) => number;

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

export function isPiSyntheticSummaryUserMessage(message: AgentMessage): boolean {
  if (message.role !== 'user' || !('content' in message)) return false;
  const text = contentText(message.content).trimStart();
  return text.startsWith('Internal session summary from earlier turns.')
    || text.startsWith('<internal_session_summary>')
    || text.includes('\n<internal_session_summary>');
}

export function isPiActionableUserMessage(message: AgentMessage): boolean {
  if (message.role !== 'user' || isPiSyntheticSummaryUserMessage(message)) return false;
  if (!('content' in message)) return false;
  if (typeof message.content === 'string') return Boolean(message.content.trim());
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const record = part as unknown as Record<string, unknown>;
    if (record.type === 'text' || record.type === 'input_text') {
      return typeof record.text === 'string' && Boolean(record.text.trim());
    }
    return true;
  });
}

export function isPiVisibleAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== 'assistant' || !('content' in message)) return false;
  return Boolean(contentText(message.content).trim());
}

function countMessages(units: readonly PiHistoryUnit[]): number {
  return units.reduce((total, unit) => total + unit.messages.length, 0);
}

function sum(units: readonly PiHistoryUnit[], measure: MeasureUnit): number {
  return units.reduce((total, unit) => total + measure(unit), 0);
}

function protectedHeadEnd(
  units: readonly PiHistoryUnit[],
  protectFirstMessages: number,
  hasPriorCompaction: boolean,
): { end: number; effectiveProtectFirstMessages: number } {
  let end = 0;
  if (units[0]?.messages[0] && (units[0].messages[0] as { role?: string }).role === 'system') {
    end = 1;
  }
  const effectiveProtectFirstMessages = hasPriorCompaction
    ? 0
    : Math.max(0, Math.floor(protectFirstMessages));
  let protectedMessages = 0;
  while (end < units.length && protectedMessages < effectiveProtectFirstMessages) {
    protectedMessages += units[end].messages.length;
    end += 1;
  }
  return { end, effectiveProtectFirstMessages };
}

function suffixStartForMessageFloor(
  units: readonly PiHistoryUnit[],
  start: number,
  messageFloor: number,
): number {
  let count = 0;
  for (let index = units.length - 1; index >= start; index -= 1) {
    count += units[index].messages.length;
    if (count >= messageFloor) return index;
  }
  return units.length;
}

function findLastUnitIndex(
  units: readonly PiHistoryUnit[],
  start: number,
  predicate: (message: AgentMessage) => boolean,
): number {
  for (let index = units.length - 1; index >= start; index -= 1) {
    if (units[index].messages.some(predicate)) return index;
  }
  return -1;
}

function findLastAssistantUnitIndex(units: readonly PiHistoryUnit[], start: number): number {
  const visible = findLastUnitIndex(units, start, isPiVisibleAssistantMessage);
  if (visible >= 0) return visible;
  return findLastUnitIndex(
    units,
    start,
    (message) => message.role === 'assistant',
  );
}

/** Hermes-style head/middle/tail selection over Canvas' atomic history units. */
export function selectPiCompactionUnits(input: {
  units: readonly PiHistoryUnit[];
  targetTailTokens: number;
  availableHistoryTokens: number;
  availableHistoryBytes: number;
  summaryTokens: number;
  summaryBytes: number;
  protectFirstMessages: number;
  protectLastMessages: number;
  hasPriorCompaction: boolean;
  mustCompact: boolean;
  measureTokens: MeasureUnit;
  measureBytes: MeasureUnit;
}): PiCompactionSelection {
  const units = input.units;
  const head = protectedHeadEnd(
    units,
    input.protectFirstMessages,
    input.hasPriorCompaction,
  );
  const headUnits = units.slice(0, head.end);
  const headTokens = sum(headUnits, input.measureTokens);
  const headBytes = sum(headUnits, input.measureBytes);
  const tailTokenHardLimit = Math.max(
    0,
    input.availableHistoryTokens - input.summaryTokens - headTokens,
  );
  const tailByteHardLimit = Math.max(
    0,
    input.availableHistoryBytes - input.summaryBytes - headBytes,
  );
  const availableTailMessages = countMessages(units.slice(head.end));
  const configuredFloor = Math.max(
    MINIMUM_TAIL_MESSAGES,
    Math.min(Math.floor(input.protectLastMessages), MAX_TAIL_MESSAGE_FLOOR),
  );
  const compressibleTailCap = Math.max(
    MINIMUM_TAIL_MESSAGES,
    availableTailMessages - 2,
  );
  const minimumTailMessages = availableTailMessages > 1
    ? Math.min(configuredFloor, compressibleTailCap, availableTailMessages)
    : 0;

  let tailStart = head.end;
  if (input.mustCompact && head.end < units.length) {
    const softCeiling = Math.max(
      1,
      Math.min(
        tailTokenHardLimit,
        Math.floor(input.targetTailTokens * TAIL_SOFT_CEILING_RATIO),
      ),
    );
    let accumulated = 0;
    let accumulatedBytes = 0;
    let accumulatedMessages = 0;
    tailStart = units.length;
    for (let index = units.length - 1; index >= head.end; index -= 1) {
      const next = input.measureTokens(units[index]);
      const nextBytes = input.measureBytes(units[index]);
      if (
        (accumulated + next > softCeiling
          || accumulatedBytes + nextBytes > tailByteHardLimit)
        && accumulatedMessages >= minimumTailMessages
      ) break;
      accumulated += next;
      accumulatedBytes += nextBytes;
      accumulatedMessages += units[index].messages.length;
      tailStart = index;
    }

    if (tailStart <= head.end && accumulated <= softCeiling && accumulated > 0) {
      accumulated = 0;
      accumulatedBytes = 0;
      accumulatedMessages = 0;
      for (let index = units.length - 1; index >= head.end; index -= 1) {
        const next = input.measureTokens(units[index]);
        const nextBytes = input.measureBytes(units[index]);
        if (
          (accumulated + next > Math.min(input.targetTailTokens, tailTokenHardLimit)
            || accumulatedBytes + nextBytes > tailByteHardLimit)
          && accumulatedMessages >= minimumTailMessages
        ) {
          tailStart = index + 1;
          break;
        }
        accumulated += next;
        accumulatedBytes += nextBytes;
        accumulatedMessages += units[index].messages.length;
        tailStart = index;
      }
    }

    const floorStart = suffixStartForMessageFloor(units, head.end, minimumTailMessages);
    tailStart = Math.min(tailStart, floorStart);
    if (tailStart <= head.end) {
      tailStart = Math.max(head.end + 1, floorStart);
    }

    const lastUserUnit = findLastUnitIndex(units, head.end, isPiActionableUserMessage);
    const lastAssistantUnit = findLastAssistantUnitIndex(units, head.end);
    if (lastUserUnit >= 0) tailStart = Math.min(tailStart, lastUserUnit);
    if (lastAssistantUnit >= 0) tailStart = Math.min(tailStart, lastAssistantUnit);
    tailStart = Math.max(head.end, Math.min(units.length, tailStart));
  }

  const middleUnits = units.slice(head.end, tailStart);
  const tailUnits = units.slice(tailStart);
  const keptUnits = [...headUnits, ...tailUnits];
  const tailTokens = sum(tailUnits, input.measureTokens);
  const keptTokens = headTokens + tailTokens;
  const keptBytes = headBytes + sum(tailUnits, input.measureBytes);
  const lastUserUnit = findLastUnitIndex(units, head.end, isPiActionableUserMessage);
  const lastAssistantUnit = findLastAssistantUnitIndex(units, head.end);

  return Object.freeze({
    headUnits: Object.freeze(headUnits),
    middleUnits: Object.freeze(middleUnits),
    tailUnits: Object.freeze(tailUnits),
    keptUnits: Object.freeze(keptUnits),
    effectiveProtectFirstMessages: head.effectiveProtectFirstMessages,
    minimumTailMessages,
    headTokens,
    tailTokens,
    keptTokens,
    keptBytes,
    minimumRequiredTokens: input.summaryTokens + keptTokens,
    minimumRequiredBytes: input.summaryBytes + keptBytes,
    activeUserAnchored: lastUserUnit < 0 || keptUnits.includes(units[lastUserUnit]),
    visibleAssistantAnchored: lastAssistantUnit < 0 || keptUnits.includes(units[lastAssistantUnit]),
  });
}
