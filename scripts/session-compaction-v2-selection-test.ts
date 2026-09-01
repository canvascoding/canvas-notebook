/**
 * Selection invariants adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  isPiActionableUserMessage,
  isPiSyntheticSummaryUserMessage,
  selectPiCompactionUnits,
} from '../app/lib/pi/compaction/selection';
import {
  buildPiHistoryUnits,
  type PiHistoryUnit,
} from '../app/lib/pi/compaction/units';

type MeasuredMessage = AgentMessage & { testTokens?: number; testBytes?: number };

function message(role: 'user' | 'assistant', content: unknown, tokens = 100): MeasuredMessage {
  return {
    role,
    content,
    timestamp: Date.now(),
    ...(role === 'assistant'
      ? { api: 'test', provider: 'test', model: 'test', stopReason: 'stop' }
      : {}),
    testTokens: tokens,
    testBytes: tokens * 4,
  } as unknown as MeasuredMessage;
}

function measureTokens(unit: PiHistoryUnit): number {
  return unit.messages.reduce(
    (total, candidate) => total + ((candidate as MeasuredMessage).testTokens ?? 100),
    0,
  );
}

function measureBytes(unit: PiHistoryUnit): number {
  return unit.messages.reduce(
    (total, candidate) => total + ((candidate as MeasuredMessage).testBytes ?? 400),
    0,
  );
}

function select(units: PiHistoryUnit[], hasPriorCompaction = false) {
  return selectPiCompactionUnits({
    units,
    targetTailTokens: 250,
    availableHistoryTokens: 10_000,
    availableHistoryBytes: 100_000,
    summaryTokens: 100,
    summaryBytes: 400,
    protectFirstMessages: 3,
    protectLastMessages: 20,
    hasPriorCompaction,
    mustCompact: true,
    measureTokens,
    measureBytes,
  });
}

function main(): void {
  const syntheticSummary = message(
    'user',
    'Internal session summary from earlier turns.\n<internal_session_summary>old</internal_session_summary>',
  );
  assert.equal(isPiSyntheticSummaryUserMessage(syntheticSummary), true);
  assert.equal(isPiActionableUserMessage(syntheticSummary), false);
  assert.equal(isPiActionableUserMessage(message('user', '   ')), false);
  assert.equal(isPiActionableUserMessage(message('user', 'real request')), true);

  const activeAssistant = message('assistant', [{ type: 'text', text: 'Visible result' }]);
  const activeUser = message('user', 'Finish the active task');
  const anchorMessages = [
    message('user', 'initial task'),
    message('assistant', [{ type: 'text', text: 'initial response' }]),
    message('user', 'initial constraint'),
    message('assistant', [{ type: 'text', text: 'compressible old response' }]),
    message('user', 'compressible old ask'),
    activeAssistant,
    activeUser,
    syntheticSummary,
    message('assistant', [{ type: 'toolCall', id: 'tail-call', name: 'read', arguments: {} }]),
    message('user', '   '),
    message('assistant', [{ type: 'toolCall', id: 'tail-open', name: 'read', arguments: {} }]),
    message('user', '   '),
    message('assistant', [{ type: 'toolCall', id: 'tail-open-2', name: 'read', arguments: {} }]),
    message('user', '   '),
    message('assistant', [{ type: 'toolCall', id: 'tail-open-3', name: 'read', arguments: {} }]),
  ] as AgentMessage[];
  const anchorUnits = buildPiHistoryUnits(anchorMessages);
  const first = select(anchorUnits);
  assert.deepEqual(first.headUnits.flatMap((unit) => unit.messages), anchorMessages.slice(0, 3));
  assert.equal(first.effectiveProtectFirstMessages, 3);
  assert.equal(first.keptUnits.some((unit) => unit.messages.includes(activeUser)), true);
  assert.equal(first.keptUnits.some((unit) => unit.messages.includes(activeAssistant)), true);
  assert.equal(first.activeUserAnchored, true);
  assert.equal(first.visibleAssistantAnchored, true);
  assert.ok(first.middleUnits.length > 0);

  const subsequent = select(anchorUnits, true);
  assert.equal(subsequent.effectiveProtectFirstMessages, 0);
  assert.equal(subsequent.headUnits.length, 0, 'the initial head must decay after compaction');
  assert.equal(subsequent.activeUserAnchored, true);
  assert.equal(subsequent.visibleAssistantAnchored, true);

  const toolParent = {
    ...message('assistant', [
      { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'a' } },
      { type: 'toolCall', id: 'call-b', name: 'read', arguments: { path: 'b' } },
    ], 500),
    stopReason: 'toolUse',
  } as AgentMessage;
  const toolA = {
    role: 'toolResult',
    toolCallId: 'call-a',
    toolName: 'read',
    content: [{ type: 'text', text: 'a' }],
    timestamp: Date.now(),
    testTokens: 500,
    testBytes: 2_000,
  } as unknown as AgentMessage;
  const toolB = {
    role: 'toolResult',
    toolCallId: 'call-b',
    toolName: 'read',
    content: [{ type: 'text', text: 'b' }],
    timestamp: Date.now(),
    testTokens: 500,
    testBytes: 2_000,
  } as unknown as AgentMessage;
  const toolHistory = [
    message('user', 'head one'),
    message('assistant', [{ type: 'text', text: 'head two' }]),
    message('user', 'head three'),
    toolParent,
    toolA,
    toolB,
    ...Array.from({ length: 8 }, (_, index) => (
      index % 2 === 0
        ? message('user', `recent user ${index}`)
        : message('assistant', [{ type: 'text', text: `recent assistant ${index}` }])
    )),
  ] as AgentMessage[];
  const toolUnits = buildPiHistoryUnits(toolHistory);
  const toolGroup = toolUnits.find((unit) => unit.kind === 'tool_group');
  assert.ok(toolGroup);
  assert.equal(toolGroup.messages.length, 3);
  assert.equal(toolGroup.toolChainComplete, true);
  const toolSelection = select(toolUnits);
  assert.equal(toolSelection.middleUnits.includes(toolGroup), true);
  assert.equal(toolSelection.keptUnits.includes(toolGroup), false);
  assert.equal(
    toolSelection.keptUnits.flatMap((unit) => unit.messages).some(
      (candidate) => candidate === toolParent || candidate === toolA || candidate === toolB,
    ),
    false,
    'tool parent and all results must cross the boundary together',
  );

  const short = select(buildPiHistoryUnits([
    message('user', 'one'),
    message('assistant', [{ type: 'text', text: 'two' }]),
    message('user', 'three'),
    message('assistant', [{ type: 'text', text: 'four' }]),
  ] as AgentMessage[]));
  assert.equal(short.middleUnits.length, 0, 'a short protected transcript has no safe middle');

  console.log('session-compaction-v2-selection-test: ok');
}

main();
