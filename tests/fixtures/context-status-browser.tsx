import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import messages from '../../messages/en.json';
import { ChatHeader } from '../../app/components/canvas-agent-chat/ChatHeader';
import { ChatRuntimeNotice } from '../../app/components/canvas-agent-chat/ChatRuntimeNotice';
import { formatContextTokens, getContextStatusDisplay } from '../../app/components/canvas-agent-chat/contextStatusDisplay';
import { IDLE_RUNTIME_COMPACTION_STATUS, type RuntimeStatus } from '../../app/lib/chat/runtime-status';

const initial: RuntimeStatus = {
  sessionId: 'context-regression', phase: 'streaming', activeTool: null, pendingToolCalls: 0,
  followUpQueue: [], steeringQueue: [], canAbort: true, contextWindow: 262_000,
  estimatedHistoryTokens: 108_000, availableHistoryTokens: 230_000, contextUsagePercent: 47,
  contextPressure: { pressureTokens: 169_540, triggerTokens: 173_000, targetTokens: 35_000,
    effectiveInputBudgetTokens: 230_000, percentOfTrigger: 98, source: 'serialized_request' },
  nextRequestEstimatedTokens: 210_000, nextRequestEstimateSource: 'serialized_request',
  lastProviderInputTokens: 108_000,
  contextMeasurement: { revision: 1, measuredRevision: 1, measuredAt: '2026-09-08T12:00:00Z', state: 'current' },
  includedSummary: false, omittedMessageCount: 0, summaryUpdatedAt: null,
  lastCompactionAt: null, lastCompactionKind: null, lastCompactionOmittedCount: 0,
  compactionStatus: IDLE_RUNTIME_COMPACTION_STATUS,
};
function Fixture() {
  const t = useTranslations('chat');
  const [status, setStatus] = useState(initial);
  const display = getContextStatusDisplay(status);
  const label = display.source === 'pressure' ? t('contextPressureLabel', {
    pressure: formatContextTokens(display.pressureTokens), trigger: formatContextTokens(display.triggerTokens),
    target: formatContextTokens(display.targetTokens), budget: formatContextTokens(display.effectiveInputBudgetTokens),
    window: formatContextTokens(display.contextWindow),
  }) : 'Legacy context budget';
  const updatePercent = (percent: number) => setStatus({
    ...initial, phase: 'idle', contextPressure: { ...initial.contextPressure!,
      percentOfTrigger: percent, pressureTokens: Math.round(percent * 1730) },
  });
  return <main className="mx-auto max-w-4xl bg-background text-foreground">
    <ChatHeader activeAgentDisplayName="Bradley" activeSessionAgentId="test" chatAgentOptions={[]}
      contextDetailedLabel={label} contextTooltip="Estimated next-request context"
      hideNavHeader isHistoryOverlayOpen={false} isMobile={false} isSessionTitleGenerating={false}
      onCompact={() => updatePercent(20)} onDeleteSession={() => {}}
      onSelectAgent={() => {}} onReloadAgents={async () => {}} onSetShowHistory={() => {}}
      onStartNewChat={() => {}} runtimeStatus={status} sessionDisplayLabel="Context measurement regression"
      sessionId={status.sessionId} showHistory={false} showSkillsLink={false}
      showWorkspaceSwitcher={false} totalUnreadCount={0} />
    <div className="min-h-72 p-6"><p>Assistant response — {status.phase}</p></div>
    <ChatRuntimeNotice status={status} />
    <div className="mt-6 flex flex-wrap gap-2 border-t p-4">
      <button onClick={() => setStatus({ ...status, phase: 'idle' })}>Finish</button>
      <button onClick={() => setStatus({ ...status, phase: 'streaming' })}>Stream</button>
      <button onClick={() => setStatus({ ...status, phase: 'aborting' })}>Abort</button>
      <button onClick={() => setStatus({ ...status, contextMeasurement: { ...status.contextMeasurement!, state: 'updating' } })}>Refresh</button>
      <button onClick={() => setStatus({ ...status, contextMeasurement: { ...status.contextMeasurement!, state: 'unavailable' } })}>Unavailable</button>
      <button onClick={() => updatePercent(63)}>New 63%</button>
      <button onClick={() => updatePercent(110)}>Trigger reached</button>
      <button onClick={() => setStatus({ ...initial, nextRequestBudgetExceeded: true })}>Overflow</button>
      <button onClick={() => setStatus({ ...initial, contextPressure: undefined,
        nextRequestEstimatedTokens: undefined, contextUsagePercent: 90 })}>Legacy</button>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><Fixture /></NextIntlClientProvider>,
);
