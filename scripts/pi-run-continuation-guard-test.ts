import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';

import {
  createToolTailContinuationDecision,
  shouldContinueAfterIntermediateAck,
} from '../app/lib/pi/run-continuation-guard';

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  };
}

function user(text: string): Extract<AgentMessage, { role: 'user' }> {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

function toolResult(): Extract<AgentMessage, { role: 'toolResult' }> {
  return {
    role: 'toolResult',
    toolCallId: 'tool-1',
    toolName: 'exec_command',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: Date.now(),
  };
}

{
  const decision = createToolTailContinuationDecision([
    user('Baue ein Modell und speichere Dateien.'),
    assistant('Ich lese die Dateien.'),
    toolResult(),
  ]);

  assert.equal(decision?.reason, 'tool_tail');
}

{
  const decision = createToolTailContinuationDecision([
    user('Baue ein Modell und speichere Dateien.'),
    assistant('Ich lese die Dateien.'),
    toolResult(),
    assistant('Fertig, die Datei ist gespeichert.'),
  ]);

  assert.equal(decision, null);
}

{
  const decision = shouldContinueAfterIntermediateAck({
    userMessage: 'Extrahier die Zahlen, speichere sie als CSV, baue ein Python-Script und erstelle am Ende eine Präsentation.',
    assistantMessage: assistant('Jetzt baue ich die Präsentation mit PptxGenJS - professionelles Midnight-Executive-Design.'),
    toolsAvailable: true,
    syntheticContinuationCount: 0,
  });

  assert.equal(decision?.reason, 'intermediate_ack');
}

{
  const decision = shouldContinueAfterIntermediateAck({
    userMessage: 'Extrahier die Zahlen, speichere sie als CSV und erstelle am Ende eine Präsentation.',
    assistantMessage: assistant('Alles ist fertig! Die CSV, das Python-Script und die Präsentation wurden erstellt.'),
    toolsAvailable: true,
    syntheticContinuationCount: 0,
  });

  assert.equal(decision, null);
}

{
  const decision = shouldContinueAfterIntermediateAck({
    userMessage: 'Extrahier die Zahlen, speichere sie als CSV und erstelle am Ende eine Präsentation.',
    assistantMessage: assistant('Jetzt baue ich die Präsentation mit PptxGenJS.'),
    toolsAvailable: true,
    syntheticContinuationCount: 2,
  });

  assert.equal(decision, null);
}

{
  const decision = shouldContinueAfterIntermediateAck({
    userMessage: 'Extrahier die Zahlen, speichere sie als CSV und erstelle am Ende eine Präsentation.',
    assistantMessage: assistant('Welche Variante soll ich fuer die Praesentation verwenden?'),
    toolsAvailable: true,
    syntheticContinuationCount: 0,
  });

  assert.equal(decision, null);
}

{
  const decision = shouldContinueAfterIntermediateAck({
    userMessage: 'Extrahier die Zahlen, speichere sie als CSV und erstelle am Ende eine Präsentation.',
    assistantMessage: assistant('Jetzt baue ich die Präsentation mit PptxGenJS.'),
    toolsAvailable: false,
    syntheticContinuationCount: 0,
  });

  assert.equal(decision, null);
}

console.log('pi-run-continuation-guard-test passed');
