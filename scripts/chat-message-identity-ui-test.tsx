import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatMessageIdentity } from '../app/components/canvas-agent-chat/ChatMessageIdentity';
import type { ResolvedUserProfile } from '../app/lib/user-profile/types';

function renderUserIdentity(profile: ResolvedUserProfile | null): string {
  return renderToStaticMarkup(
    <ChatMessageIdentity
      role="user"
      agentId="bradley"
      userProfile={profile}
    />,
  );
}

function main(): void {
  const bradley = renderToStaticMarkup(
    <ChatMessageIdentity
      role="assistant"
      agentId="bradley"
      agentIconId="bot"
      userProfile={null}
    />,
  );
  assert.match(bradley, /data-testid="chat-message-identity-assistant"/u);
  assert.match(bradley, /viewBox="0 0 64 64"/u);
  assert.doesNotMatch(bradley, /lucide-bot/u);

  const specialist = renderToStaticMarkup(
    <ChatMessageIdentity
      role="assistant"
      agentId="research-agent"
      agentIconId="search"
      userProfile={null}
    />,
  );
  assert.match(specialist, /data-agent-icon-id="search"/u);
  assert.match(specialist, /src="\/images\/agents\/origami\/search\.svg"/u);
  assert.doesNotMatch(specialist, /viewBox="0 0 64 64"/u);

  const image = renderUserIdentity({
    name: 'Alex Weber',
    avatarKind: 'image',
    iconId: null,
    initials: 'AW',
    imageUrl: '/api/account/profile/avatar?v=3',
    revision: 3,
  });
  assert.match(image, /data-avatar-kind="image"/u);
  assert.match(image, /src="\/api\/account\/profile\/avatar\?v=3"/u);

  const icon = renderUserIdentity({
    name: 'Alex Weber',
    avatarKind: 'icon',
    iconId: 'rocket',
    initials: 'AW',
    imageUrl: null,
    revision: 4,
  });
  assert.match(icon, /data-avatar-kind="icon"/u);
  assert.match(icon, /lucide-rocket/u);

  const initials = renderUserIdentity({
    name: 'Alex Weber',
    avatarKind: 'initials',
    iconId: null,
    initials: 'AW',
    imageUrl: null,
    revision: 5,
  });
  assert.match(initials, /data-avatar-kind="initials"/u);
  assert.match(initials, />AW<\/span>/u);

  const fallback = renderUserIdentity(null);
  assert.match(fallback, /data-testid="chat-message-identity-user"/u);
  assert.match(fallback, /lucide-user-round/u);

  const root = process.cwd();
  const chatSource = readFileSync(path.join(root, 'app/components/canvas-agent-chat/CanvasAgentChat.tsx'), 'utf8');
  const messageListSource = readFileSync(path.join(root, 'app/components/canvas-agent-chat/ChatMessageList.tsx'), 'utf8');
  assert.match(chatSource, /currentUserProfile = useCurrentUserProfile\(\)/u);
  assert.match(chatSource, /assistantAgentId=\{activeSessionAgentId\}/u);
  assert.match(chatSource, /assistantIconId=\{activeAgentProfile\?\.iconId\}/u);
  assert.match(chatSource, /userProfile=\{currentUserProfile\}/u);
  assert.match(messageListSource, /<ChatMessageIdentity/u);
  assert.match(messageListSource, /role=\{isUser \? 'user' : 'assistant'\}/u);

  console.log('chat-message-identity-ui-test: ok');
}

main();
