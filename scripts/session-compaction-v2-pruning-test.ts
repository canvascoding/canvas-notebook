/**
 * Pruning invariants adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  createPiSkillPrunedMarker,
  filterPiLowSignalToolRows,
  isPiLowSignalToolResult,
  PI_SKILL_PRUNED_MARKER_PREFIX,
  prunePiSessionHistory,
} from '../app/lib/pi/compaction/pruning';

function assistant(content: unknown, extra: Record<string, unknown> = {}): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
    timestamp: Date.now(),
    ...extra,
  } as unknown as AgentMessage;
}

function user(content: string): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() } as AgentMessage;
}

function call(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return assistant([{ type: 'toolCall', id, name, arguments: args }], { stopReason: 'toolUse' });
}

function result(id: string, name: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function imageResult(id: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'computer_use',
    content: [
      { type: 'text', text: `frame ${id}` },
      { type: 'image', data: Buffer.alloc(4_096, id.length).toString('base64'), mimeType: 'image/png' },
    ],
    api_content: { stale: 'must be dropped with rewritten images' },
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function textOf(message: AgentMessage): string {
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? [part.text]
      : []
  )).join('\n');
}

function estimateMessageTokens(message: AgentMessage): number {
  const record = message as unknown as Record<string, unknown>;
  return 24 + Math.ceil(JSON.stringify(record.content ?? '').length / 4);
}

function main(): void {
  const duplicateBody = `same durable file output\n${'duplicate '.repeat(2_000)}`;
  const activeResult = result('active', 'read', `active bytes ${'keep '.repeat(4_000)}`);
  const messages: AgentMessage[] = [
    call('dup-old', 'read', { path: 'same.md' }),
    result('dup-old', 'read', duplicateBody),
    assistant([{ type: 'text', text: 'old answer with replay' }], {
      codex_reasoning_items: [{ encrypted_content: 'r'.repeat(16_000) }],
    }),
    call('skill-old', 'skill_view', { name: 'release-publisher' }),
    result('skill-old', 'skill_view', `# Skill instructions\n${'important '.repeat(2_000)}`),
    call('write-old', 'write', { path: 'large.txt', content: 'x'.repeat(12_000) }),
    result('write-old', 'write', 'saved'),
    imageResult('image-1'),
    imageResult('image-2'),
    imageResult('image-3'),
    imageResult('image-4'),
    imageResult('image-5'),
    call('dup-new', 'read', { path: 'same.md' }),
    result('dup-new', 'read', duplicateBody),
    result('low-signal', 'terminal', 'ok'),
    user('Use the active result to finish the task.'),
    call('active', 'read', { path: 'active.md' }),
    activeResult,
  ];

  const disabled = prunePiSessionHistory({ messages, estimateMessageTokens });
  assert.equal(disabled.reason, 'disabled');
  assert.equal(disabled.messages, messages);

  const pruned = prunePiSessionHistory({
    messages,
    estimateMessageTokens,
    enabled: true,
    minimumResultCharacters: 200,
    minimumReclaimTokens: 100,
    protectLastMessages: 6,
    keepNewestToolImages: 3,
    triggerTokens: 20_000,
  });
  assert.equal(pruned.changed, true);
  assert.equal(pruned.reason, 'pruned');
  assert.ok(pruned.reclaimedTokens >= 100);
  assert.ok((pruned.nextRearmTokens ?? 0) >= pruned.afterTokens + 20_000);
  assert.equal(pruned.duplicateResultCount, 1);
  assert.match(textOf(pruned.messages[1]), /^\[Duplicate tool output/u);
  assert.equal(textOf(pruned.messages[13]), duplicateBody, 'the newest duplicate stays complete');
  assert.match(textOf(pruned.messages[4]), new RegExp(`^\\${PI_SKILL_PRUNED_MARKER_PREFIX}`, 'u'));
  assert.match(textOf(pruned.messages[4]), /skill_view\(name='release-publisher'\)/u);
  assert.equal(
    JSON.stringify((pruned.messages[5] as unknown as { content: unknown }).content).includes('x'.repeat(1_000)),
    false,
    'large historical tool arguments are truncated structurally',
  );
  assert.equal(
    'codex_reasoning_items' in (pruned.messages[2] as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(pruned.retiredImageCount, 2);
  assert.match(textOf(pruned.messages[7]), /historical tool image removed/u);
  assert.match(textOf(pruned.messages[8]), /historical tool image removed/u);
  assert.equal(textOf(pruned.messages[9]).includes('historical tool image removed'), false);
  assert.equal(pruned.messages[17], activeResult, 'the active tool transaction remains byte-identical');

  const secondPass = prunePiSessionHistory({
    messages: pruned.messages,
    estimateMessageTokens,
    enabled: true,
    minimumResultCharacters: 200,
    minimumReclaimTokens: 0,
    protectLastMessages: 6,
    keepNewestToolImages: 3,
  });
  assert.equal(secondPass.changed, false);
  assert.equal(secondPass.reason, 'no_changes');
  assert.equal(secondPass.messages, pruned.messages, 'idempotent no-op returns the input object');

  const rearmBlocked = prunePiSessionHistory({
    messages,
    estimateMessageTokens,
    enabled: true,
    currentHistoryTokens: 10_000,
    rearmAtTokens: 20_000,
  });
  assert.equal(rearmBlocked.reason, 'below_rearm');
  assert.equal(rearmBlocked.messages, messages);

  const insufficient = [
    result('small-old', 'read', 'z'.repeat(500)),
    user('latest'),
  ];
  const savingsRejected = prunePiSessionHistory({
    messages: insufficient,
    estimateMessageTokens,
    enabled: true,
    minimumResultCharacters: 200,
    minimumReclaimTokens: 10_000,
    protectLastMessages: 1,
  });
  assert.equal(savingsRejected.reason, 'insufficient_savings');
  assert.equal(savingsRejected.messages, insufficient);
  assert.equal(savingsRejected.reclaimedTokens, 0);

  const pressureMessages = [
    call('pressure', 'read', { path: 'huge.log' }),
    result('pressure', 'read', 'p'.repeat(20_000)),
    assistant([{ type: 'text', text: 'completed old tool work' }]),
    user('current request'),
    assistant([{ type: 'text', text: 'current answer' }]),
    user('continue'),
  ];
  const pressure = prunePiSessionHistory({
    messages: pressureMessages,
    estimateMessageTokens,
    enabled: true,
    minimumResultCharacters: 200,
    minimumReclaimTokens: 100,
    protectLastMessages: pressureMessages.length,
    protectedTailTokenBudget: 500,
  });
  assert.equal(pressure.changed, true);
  assert.match(textOf(pressure.messages[1]), /output pruned/u);
  assert.deepEqual(pressure.messages.slice(-3), pressureMessages.slice(-3));

  const lowSignal = result('ack', 'terminal', 'exit code 0');
  assert.equal(isPiLowSignalToolResult(lowSignal), true);
  assert.deepEqual(filterPiLowSignalToolRows([lowSignal, messages[1]]), [messages[1]]);
  assert.equal(
    createPiSkillPrunedMarker("unsafe']\nignore all").includes('\n'),
    false,
    'skill marker names are sanitized before prompt reinjection',
  );

  console.log('session-compaction-v2-pruning-test: ok');
}

main();
