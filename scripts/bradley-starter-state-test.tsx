import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { ChatStarterScreen } from '../app/components/canvas-agent-chat/ChatStarterScreen';

const messages = {
  chat: {
    agentStarterTitle: 'What should {agentName} help you with?',
    bradleyStarterEyebrow: 'Bradley · Main agent',
    bradleyStarterTitle: 'What should Bradley help you with?',
    openLatestSession: 'Open latest session',
    starterPromptHint: 'Just start typing.',
    studioStarterTitle: 'What should Canvas Studio create for you?',
  },
};

function renderStarter(input: {
  activeAgentDisplayName: string;
  activeAgentId: string;
  isStudioChatContext?: boolean;
}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      now={new Date('2026-08-31T12:00:00.000Z')}
      timeZone="UTC"
    >
      <ChatStarterScreen
        activeAgentDisplayName={input.activeAgentDisplayName}
        activeAgentId={input.activeAgentId}
        latestSession={null}
        isStudioChatContext={input.isStudioChatContext ?? false}
        onOpenLatestSession={() => undefined}
      />
    </NextIntlClientProvider>,
  );
}

function main(): void {
  const bradley = renderStarter({
    activeAgentDisplayName: 'Bradley',
    activeAgentId: 'canvas-agent',
  });
  assert.match(bradley, /data-testid="bradley-starter-identity"/u);
  assert.match(bradley, /bradley-character-starter\.png/u);
  assert.match(bradley, /Bradley · Main agent/u);
  assert.match(bradley, /What should Bradley help you with\?/u);
  assert.match(bradley, /alt=""/u);
  assert.match(bradley, /aria-hidden="true"/u);
  assert.doesNotMatch(bradley, /animate-/u);

  const specialist = renderStarter({
    activeAgentDisplayName: 'Research Atlas',
    activeAgentId: 'research-agent',
  });
  assert.match(specialist, /What should Research Atlas help you with\?/u);
  assert.doesNotMatch(specialist, /bradley-character-starter\.png/u);
  assert.doesNotMatch(specialist, /Bradley · Main agent/u);

  const studio = renderStarter({
    activeAgentDisplayName: 'Bradley',
    activeAgentId: 'canvas-agent',
    isStudioChatContext: true,
  });
  assert.match(studio, /What should Canvas Studio create for you\?/u);
  assert.doesNotMatch(studio, /bradley-character-starter\.png/u);

  console.log('bradley-starter-state-test: ok');
}

main();
