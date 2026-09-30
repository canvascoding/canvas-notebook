import React from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ToolCallPill } from '../../app/components/canvas-agent-chat/ChatToolRunMessages';
import type { ChatMessage } from '../../app/lib/chat/types';
import messages from '../../messages/de.json';

const options = {
  agentId: 'matthias',
  agents: [{ agentId: 'matthias', name: 'Matthias' }],
  deliverySessionModes: ['new_session', 'channel_active', 'fixed_session'],
  chats: [{ sessionId: 'matthias-chat', title: 'Berichte' }],
};
const result: ChatMessage = {
  id: 'options', role: 'assistant', type: 'tool_result', status: 'sent',
  toolName: 'inspect_automation_job_options', toolArgs: JSON.stringify({ agentId: 'matthias' }),
  content: JSON.stringify(options, null, 2),
};

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="de" timeZone="Europe/Berlin" messages={messages}>
    <main className="p-6"><ToolCallPill message={result} /></main>
  </NextIntlClientProvider>,
);
