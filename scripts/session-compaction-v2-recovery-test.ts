/**
 * Recovery-artifact invariants adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  boundPiCompactionSummaryInput,
  buildPiCompactionAnchorIndex,
  buildPiCompactionDigestChunks,
  buildPiCompactionRecoveryArtifacts,
  buildPiCompactionRecoveryFooter,
  buildPiCompactionVerbatimUserSection,
  redactPiCompactionText,
  renderPiCompactionChunkDigests,
} from '../app/lib/pi/compaction/recovery';

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as AgentMessage;
}

function main(): void {
  const knownSecret = 'KNOWN-SUPER-SECRET';
  const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz.abcdefghijklm.abcdefghijklm';
  const credentialUrl = 'https://alice:password@example.com/callback?code=oauth-secret&view=ok#fragment';
  const redacted = redactPiCompactionText(
    `API_KEY=${apiKey}\nAuthorization: ${bearer}\n${credentialUrl}\n${knownSecret}`,
    [knownSecret],
  );
  for (const secret of [apiKey, bearer.slice('Bearer '.length), 'alice', 'password', 'oauth-secret', knownSecret]) {
    assert.equal(redacted.includes(secret), false, `${secret} must be redacted`);
  }
  assert.match(redacted, /view=ok/u, 'non-sensitive URL query state survives');

  const hugeHistoricalText = [
    'Long historical findings for app/lib/pi/history-budget.ts and #1234.',
    'h'.repeat(175_000),
    knownSecret,
    'tail-of-historical-findings',
  ].join('\n');
  const syntheticSummary = user(
    'Internal session summary from earlier turns.\n<internal_session_summary>synthetic user row</internal_session_summary>',
  );
  const messages: AgentMessage[] = [
    user(
      'Implement #1234 on branch codex/hermes-session-compaction-v2 in '
      + 'app/lib/pi/history-budget.ts. workspaceId=ws_alpha todoId=todo_42 '
      + 'automationId=auto_77 sessionId=session_allowed commit '
      + '0b8fda3f43e36ad165e559b8f0d155755cc1296f version v2.3.4. '
      + 'Reference https://example.com/docs?view=ok.',
    ),
    assistant('TypeError cannot serialize app/lib/pi/history-budget.ts; keep SQLITE_BUSY exact.'),
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'call-secret',
        name: 'fetch',
        arguments: { url: credentialUrl, token: apiKey, path: 'app/lib/pi/session-summary.ts' },
      }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } as unknown as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: 'call-ack',
      toolName: 'terminal',
      content: [{ type: 'text', text: 'exit code 0' }],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
    assistant(hugeHistoricalText),
    syntheticSummary,
    user(`Keep #9999 and docs/architecture/canvas-notebook/session-compaction-v2/plan.md exact. ${knownSecret}`),
  ];

  const anchorIndex = buildPiCompactionAnchorIndex(messages, [knownSecret]);
  const anchors = new Set(Object.values(anchorIndex.categories).flat());
  for (const expected of [
    '#1234',
    '#9999',
    'codex/hermes-session-compaction-v2',
    'app/lib/pi/history-budget.ts',
    'docs/architecture/canvas-notebook/session-compaction-v2/plan.md',
    '0b8fda3f43e36ad165e559b8f0d155755cc1296f',
    'v2.3.4',
    'workspaceId=ws_alpha',
    'todoId=todo_42',
    'automationId=auto_77',
    'sessionId=session_allowed',
  ]) {
    assert.equal(anchors.has(expected), true, `supported exact anchor ${expected} must survive`);
  }
  assert.equal(anchorIndex.text.includes(knownSecret), false);
  assert.equal(anchorIndex.text.includes(apiKey), false);

  const verbatim = buildPiCompactionVerbatimUserSection(messages, [knownSecret]);
  assert.ok(verbatim.indexOf('#9999') < verbatim.indexOf('#1234'), 'real user messages are newest-first');
  assert.equal(verbatim.includes('synthetic user row'), false);
  assert.equal(verbatim.includes(knownSecret), false);
  assert.match(verbatim, /\[REDACTED\]/u);

  const artifacts = buildPiCompactionRecoveryArtifacts({
    messages,
    sessionId: 'session_allowed',
    authorizedSessionId: 'session_allowed',
    sessionSearchAvailable: true,
    knownSecrets: [knownSecret],
  });
  assert.ok(artifacts.digestChunks.length >= 3, 'large transcripts are split into chronological chunks');
  assert.ok(artifacts.digestChunks.length <= 28);
  assert.equal(
    artifacts.digestChunks.map((chunk) => chunk.content).join(''),
    artifacts.redactedTranscript,
    'chronological chunks cover the sanitized digest transcript without gaps',
  );
  artifacts.digestChunks.forEach((chunk, index) => {
    assert.equal(chunk.ordinal, index + 1);
    assert.equal(chunk.total, artifacts.digestChunks.length);
    assert.equal(chunk.digest, createHash('sha256').update(chunk.content).digest('hex'));
    assert.equal(chunk.content.includes(knownSecret), false);
    assert.equal(chunk.content.includes(apiKey), false);
    assert.equal(chunk.content.includes('exit code 0'), false, 'low-signal tool acks do not starve digests');
  });
  assert.match(artifacts.recoveryFooter, /session_search\(query='<keywords>', session_id='session_allowed'\)/u);

  assert.equal(buildPiCompactionRecoveryFooter({
    sessionId: 'session_allowed',
    authorizedSessionId: 'different-session',
    sessionSearchAvailable: true,
    compactedMessageCount: 10,
  }), '', 'a mismatched authorization scope cannot receive a recovery pointer');
  assert.equal(buildPiCompactionRecoveryFooter({
    sessionId: 'session_allowed',
    authorizedSessionId: 'session_allowed',
    sessionSearchAvailable: false,
    compactedMessageCount: 10,
  }), '', 'the footer is omitted when session_search is unavailable');

  const rebuiltChunks = buildPiCompactionDigestChunks({ messages, knownSecrets: [knownSecret] });
  const rendered = renderPiCompactionChunkDigests({
    chunks: rebuiltChunks,
    bodies: rebuiltChunks.map((chunk) => `Digest for ${chunk.digest.slice(0, 8)} ${knownSecret}`),
    knownSecrets: [knownSecret],
  });
  assert.equal(rendered.includes(knownSecret), false, 'LLM digest output is redacted before persistence');
  assert.match(rendered, /Segment 1\//u);
  assert.throws(
    () => renderPiCompactionChunkDigests({
      chunks: [...rebuiltChunks].reverse(),
      bodies: rebuiltChunks.map(() => 'body'),
    }),
    /chronological order/u,
  );

  const boundedInput = boundPiCompactionSummaryInput(
    `HEAD-SENTINEL\n${'m'.repeat(200_000)}\nTAIL-SENTINEL`,
  );
  assert.ok(boundedInput.length <= 160_000);
  assert.match(boundedInput, /^HEAD-SENTINEL/u);
  assert.match(boundedInput, /TAIL-SENTINEL$/u);
  assert.match(boundedInput, /summary input truncated: omitted/u);

  console.log('session-compaction-v2-recovery-test: ok');
}

main();
