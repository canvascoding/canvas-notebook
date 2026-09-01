import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { ChatRuntimeActivityBadge } from '../app/components/canvas-agent-chat/ChatRuntimeActivityBadge';
import {
  isConfirmedResponsePreparation,
  type RuntimeStatus,
} from '../app/lib/chat/runtime-status';

const baseStatus: RuntimeStatus = {
  sessionId: 'working-state-session',
  phase: 'streaming',
  activeTool: null,
  pendingToolCalls: 0,
  followUpQueue: [],
  steeringQueue: [],
  canAbort: true,
  contextWindow: 10_000,
  estimatedHistoryTokens: 100,
  availableHistoryTokens: 9_000,
  contextUsagePercent: 1,
  includedSummary: false,
  omittedMessageCount: 0,
  summaryUpdatedAt: null,
  lastCompactionAt: null,
  lastCompactionKind: null,
  lastCompactionOmittedCount: 0,
};

const messages = {
  chat: {
    preparingResponse: 'Bradley is preparing the response…',
    ready: 'Ready',
    stopping: 'Stopping',
    working: 'Working',
  },
};

function renderBadge(input: {
  agentId: string;
  isPreparingResponse: boolean;
  status: RuntimeStatus;
}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      now={new Date('2026-08-31T12:00:00.000Z')}
      timeZone="UTC"
    >
      <ChatRuntimeActivityBadge {...input} />
    </NextIntlClientProvider>,
  );
}

function main(): void {
  const emptyAssistantBubble = { present: true, hasVisibleOutput: false };
  assert.equal(isConfirmedResponsePreparation(baseStatus, emptyAssistantBubble), true);
  assert.equal(isConfirmedResponsePreparation({ ...baseStatus, optimistic: true }, emptyAssistantBubble), false);
  assert.equal(isConfirmedResponsePreparation(baseStatus, { present: true, hasVisibleOutput: true }), false);
  assert.equal(isConfirmedResponsePreparation(baseStatus, { present: false, hasVisibleOutput: false }), false);
  assert.equal(isConfirmedResponsePreparation({ ...baseStatus, phase: 'running_tool' }, emptyAssistantBubble), false);
  assert.equal(isConfirmedResponsePreparation({ ...baseStatus, phase: 'aborting' }, emptyAssistantBubble), false);
  assert.equal(isConfirmedResponsePreparation({ ...baseStatus, phase: 'idle' }, emptyAssistantBubble), false);

  const preparing = renderBadge({
    agentId: 'canvas-agent',
    isPreparingResponse: true,
    status: baseStatus,
  });
  assert.match(preparing, /role="status"/u);
  assert.match(preparing, /aria-live="polite"/u);
  assert.match(preparing, /Bradley is preparing the response/u);
  assert.match(preparing, /bradley-working-character/u);
  assert.match(preparing, /prefers-reduced-motion: reduce/u);
  assert.match(preparing, /animation: none !important/u);

  const responding = renderBadge({
    agentId: 'canvas-agent',
    isPreparingResponse: false,
    status: baseStatus,
  });
  assert.match(responding, />Working</u);
  assert.doesNotMatch(responding, /bradley-working-character/u);

  const specialist = renderBadge({
    agentId: 'research-agent',
    isPreparingResponse: false,
    status: baseStatus,
  });
  assert.match(specialist, />Working</u);
  assert.doesNotMatch(specialist, /viewBox="0 0 64 64"/u);

  const aborting = renderBadge({
    agentId: 'canvas-agent',
    isPreparingResponse: false,
    status: { ...baseStatus, phase: 'aborting' },
  });
  assert.match(aborting, />Stopping</u);
  assert.doesNotMatch(aborting, /viewBox="0 0 64 64"/u);

  console.log('bradley-working-state-test: ok');
}

main();
