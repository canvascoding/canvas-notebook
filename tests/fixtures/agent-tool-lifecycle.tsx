import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { ToolBatchDisclosure } from '../../app/components/canvas-agent-chat/ChatToolRunMessages';
import { useChatRuntimeEvents } from '../../app/components/canvas-agent-chat/useChatRuntimeEvents';
import { buildToolBatchProjection } from '../../app/lib/chat/run-collapse';
import type { AISession, ChatEvent, ChatMessage } from '../../app/lib/chat/types';
import messages from '../../messages/en.json';

const source: ChatMessage = {
  id: 'assistant', role: 'assistant', content: '', status: 'sent',
  piMessage: { role: 'assistant', content: [{ type: 'toolCall', id: 'manage', name: 'agent_manage', arguments: {} }],
    stopReason: 'toolUse', timestamp: 1000 } as ChatMessage['piMessage'],
};

function Harness() {
  const [entries, setEntries] = useState<ChatMessage[]>([source]);
  const [expanded, setExpanded] = useState(true);
  const [history, setHistory] = useState<AISession[]>([]);
  const t = useTranslations('chat');
  const runtime = useChatRuntimeEvents({
    deferredSavedMessageRefreshSessionRef: useRef(null), refreshSavedMessagesRef: useRef(null),
    historyRef: useRef(history), isAtBottomRef: useRef(false), messages: entries,
    scrollToBottom: () => {}, sessionIdRef: useRef('fixture'), setHistory, setMessages: setEntries, t,
  });
  Object.assign(window, { fixtureHasLiveMessages: runtime.hasLiveMessagesInProgress });
  const emit = (event: ChatEvent) => window.dispatchEvent(new CustomEvent('agent_event', { detail: { sessionId: 'fixture', event } }));
  const projection = buildToolBatchProjection(entries, runtime.runtimeStatus?.phase !== 'idle', t('toolExecutionInterrupted'));
  const batch = projection.batchesByAnchorId.get(source.id)!;
  return <main className="mx-auto max-w-2xl space-y-4 p-6">
    <h1>Agent tool lifecycle</h1>
    <button id="start" onClick={() => { setEntries([source]); emit({ type: 'tool_execution_start', toolCallId: 'manage', toolName: 'agent_manage', args: {} }); }}>Start tool</button>
    <button id="idle" onClick={() => runtime.setRuntimeStatusWithReconciliation({
      sessionId: 'fixture', revision: 2, phase: 'idle', activeTool: null, pendingToolCalls: 0,
      followUpQueue: [], steeringQueue: [], canAbort: false, contextWindow: 0, estimatedHistoryTokens: 0, availableHistoryTokens: 0, contextUsagePercent: 0, includedSummary: false, omittedMessageCount: 0, summaryUpdatedAt: null, lastCompactionAt: null, lastCompactionKind: null, lastCompactionOmittedCount: 0,
    } as Parameters<typeof runtime.setRuntimeStatusWithReconciliation>[0])}>End run</button>
    <button id="failure" onClick={() => setEntries([{ ...source, status: 'error', piMessage: {
      ...source.piMessage, stopReason: 'error', errorMessage: 'terminated',
    } as ChatMessage['piMessage'] }])}>Fail model</button>
    <button id="result" onClick={() => emit({ type: 'tool_execution_end', toolCallId: 'manage', toolName: 'agent_manage',
      result: { content: [{ type: 'text', text: 'Agent created successfully.' }], details: { operation: 'create_agent' } } })}>Deliver result</button>
    <output id="live">{String(runtime.hasLiveMessagesInProgress())}</output>
    <ToolBatchDisclosure batch={batch} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><Harness /></NextIntlClientProvider>);
