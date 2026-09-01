import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { PersistedChatMessage } from '../app/lib/chat/types';

async function main() {
  const { mapPersistedChatMessages } = await import(
    '../app/components/canvas-agent-chat/chatMessageMapping'
  );
  const {
    cancelChatDelegation,
    fetchChatDelegations,
    fetchDelegationOptions,
    startChatDelegation,
  } = await import(
    '../app/lib/chat/delegation-api'
  );
  const {
    CHAT_DELEGATION_PANEL_EXPANDED_STORAGE_KEY,
    readChatDelegationPanelExpanded,
    writeChatDelegationPanelExpanded,
  } = await import(
    '../app/lib/chat/delegation-panel-storage'
  );

  const storedPanelState = new Map<string, string>();
  const panelStorage = {
    getItem: (key: string) => storedPanelState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storedPanelState.set(key, value);
    },
  };
  assert.equal(readChatDelegationPanelExpanded(panelStorage), true);
  writeChatDelegationPanelExpanded(panelStorage, false);
  assert.equal(
    storedPanelState.get(CHAT_DELEGATION_PANEL_EXPANDED_STORAGE_KEY),
    'false',
  );
  assert.equal(readChatDelegationPanelExpanded(panelStorage), false);
  writeChatDelegationPanelExpanded(panelStorage, true);
  assert.equal(readChatDelegationPanelExpanded(panelStorage), true);
  assert.equal(readChatDelegationPanelExpanded({ getItem: () => 'invalid' }), true);
  assert.equal(readChatDelegationPanelExpanded({ getItem: () => { throw new Error('blocked'); } }), true);

  const hiddenCompletion = {
    role: 'user',
    content: 'Internal delegation completion',
    timestamp: 1,
    delegationCompletion: {
      delegationId: 'delegation-ui-1',
      workerSessionId: 'worker-ui-1',
      workerType: 'ephemeral',
      status: 'completed',
    },
  } as unknown as PersistedChatMessage;
  const visibleAssistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Visible parent answer' }],
    timestamp: 2,
  } as unknown as PersistedChatMessage;

  const mapped = mapPersistedChatMessages(
    [hiddenCompletion, visibleAssistant],
    'Run stopped',
  );
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.role, 'assistant');
  assert.equal(mapped[0]?.content, 'Visible parent answer');

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (init?.method === 'DELETE') {
      return Response.json({
        success: true,
        delegation: {
          id: 'delegation-ui-1',
          status: 'cancelled',
          cancelRequestedAt: '2026-07-17T12:00:00.000Z',
          completedAt: '2026-07-17T12:00:00.000Z',
        },
      });
    }
    if (init?.method === 'POST') return Response.json({ success: true });
    if (String(input).includes('options=true')) {
      return Response.json({
        success: true,
        agents: [{ agentId: 'agent-ui-1', name: 'UI Agent', iconId: null }],
        toolsets: [{ name: 'web', label: 'Web', description: 'Browse the web' }],
      });
    }
    return Response.json({
      success: true,
      delegations: [{ id: 'delegation-ui-1', status: 'running' }],
    });
  };

  try {
    const tasks = await fetchChatDelegations('source session/one');
    assert.equal(tasks[0]?.id, 'delegation-ui-1');
    assert.equal(requests[0]?.url, '/api/delegations?sourceSessionId=source+session%2Fone');
    assert.equal(requests[0]?.init?.cache, 'no-store');

    const cancelled = await cancelChatDelegation('delegation/ui-1');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(requests[1]?.url, '/api/delegations/delegation%2Fui-1');
    assert.equal(requests[1]?.init?.method, 'DELETE');

    const options = await fetchDelegationOptions('source session/one');
    assert.equal(options.agents[0]?.agentId, 'agent-ui-1');
    assert.equal(requests[2]?.url, '/api/delegations?sourceSessionId=source+session%2Fone&options=true');

    await startChatDelegation({
      sourceSessionId: 'source-ui-1',
      targetAgentId: 'agent-ui-1',
      goal: 'Inspect the result',
      toolsets: ['web'],
    });
    assert.equal(requests[3]?.url, '/api/delegations');
    assert.equal(requests[3]?.init?.method, 'POST');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const root = process.cwd();
  const composerSource = fs.readFileSync(path.join(
    root,
    'app/components/canvas-agent-chat/ChatComposer.tsx',
  ), 'utf8');
  const chatSource = fs.readFileSync(path.join(
    root,
    'app/components/canvas-agent-chat/CanvasAgentChat.tsx',
  ), 'utf8');
  const panelSource = fs.readFileSync(path.join(
    root,
    'app/components/canvas-agent-chat/ChatDelegationPanel.tsx',
  ), 'utf8');
  const agentPickerSource = fs.readFileSync(path.join(
    root,
    'app/components/canvas-agent-chat/DelegationAgentPicker.tsx',
  ), 'utf8');
  const toolsetPickerSource = fs.readFileSync(path.join(
    root,
    'app/components/canvas-agent-chat/DelegationToolsetPicker.tsx',
  ), 'utf8');
  const runtimeEventsSource = fs.readFileSync(path.join(
    root,
    'app/components/canvas-agent-chat/useChatRuntimeEvents.ts',
  ), 'utf8');

  assert.match(composerSource, /\{delegationPanel\}/u);
  assert.match(chatSource, /<ChatDelegationPanel/u);
  assert.match(chatSource, /sourceSessionId=\{sessionId\}/u);
  assert.match(chatSource, /agents=\{chatAgentOptions\}/u);
  assert.match(panelSource, /data-testid="chat-delegation-panel"/u);
  assert.match(panelSource, /data-testid="chat-delegation-start"/u);
  assert.match(panelSource, /readChatDelegationPanelExpanded/u);
  assert.match(panelSource, /writeChatDelegationPanelExpanded/u);
  assert.match(panelSource, /<DelegationAgentPicker/u);
  assert.match(panelSource, /<DelegationToolsetPicker/u);
  assert.match(panelSource, /<AgentAvatar/u);
  assert.match(panelSource, /workerAgent\?\.name/u);
  assert.match(panelSource, /visibleToolsets/u);
  assert.doesNotMatch(panelSource, /type="checkbox"/u);
  assert.match(agentPickerSource, /<AgentAvatar/u);
  assert.match(agentPickerSource, /data-testid="delegation-agent-picker"/u);
  assert.match(agentPickerSource, /role="radiogroup"/u);
  assert.match(agentPickerSource, /type="radio"/u);
  assert.match(agentPickerSource, /useId/u);
  assert.match(agentPickerSource, /name=\{radioName\}/u);
  assert.doesNotMatch(agentPickerSource, /<Popover/u);
  assert.match(toolsetPickerSource, /aria-pressed=\{selected\}/u);
  assert.match(toolsetPickerSource, /<DelegationToolsetIcon/u);
  assert.match(toolsetPickerSource, /delegationSearchTools/u);
  assert.match(toolsetPickerSource, /filteredToolsets/u);
  assert.match(panelSource, /<Dialog open=\{dialogOpen\}/u);
  assert.match(panelSource, /overflow-y-auto/u);
  assert.match(panelSource, /lg:grid-cols/u);
  assert.match(panelSource, /cancelChatDelegation/u);
  assert.match(panelSource, /startChatDelegation/u);
  assert.match(panelSource, /delegationShowResult/u);
  assert.match(runtimeEventsSource, /!isDelegationCompletionMessage\(event\.message\)/u);

  console.log('pi-delegation-ui-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
