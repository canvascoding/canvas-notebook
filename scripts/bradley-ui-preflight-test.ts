import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function readMessages(locale: 'de' | 'en'): Record<string, unknown> {
  return JSON.parse(readProjectFile(`messages/${locale}.json`)) as Record<string, unknown>;
}

function getChatMessages(messages: Record<string, unknown>): Record<string, unknown> {
  const chat = messages.chat;
  assert.equal(typeof chat, 'object');
  assert.notEqual(chat, null);
  return chat as Record<string, unknown>;
}

async function verifyTransparentStarterAsset(): Promise<void> {
  const assetPath = path.join(
    process.cwd(),
    'public/images/bradley/bradley-character-starter.png',
  );
  const image = sharp(assetPath);
  const metadata = await image.metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2048);
  assert.equal(metadata.height, 2048);
  assert.equal(metadata.hasAlpha, true);

  const { channels } = await image.stats();
  const alpha = channels[3];
  assert.ok(alpha, 'Bradley starter asset must have an alpha channel');
  assert.equal(alpha.min, 0, 'Bradley starter asset must contain transparent pixels');
  assert.equal(alpha.max, 255, 'Bradley starter asset must contain opaque pixels');
}

async function main(): Promise<void> {
  const deChat = getChatMessages(readMessages('de'));
  const enChat = getChatMessages(readMessages('en'));
  assert.equal(deChat.preparingResponse, 'Bradley bereitet die Antwort vor …');
  assert.equal(enChat.preparingResponse, 'Bradley is preparing the response…');
  assert.equal(deChat.bradleyStarterEyebrow, 'Bradley · Hauptagent');
  assert.equal(enChat.bradleyStarterEyebrow, 'Bradley · Main agent');
  assert.equal(deChat.bradleyStarterTitle, 'Wobei soll Bradley dir helfen?');
  assert.equal(enChat.bradleyStarterTitle, 'What should Bradley help you with?');

  const identitySource = readProjectFile('app/components/agents/AgentIdentityVisual.tsx');
  assert.match(identitySource, /viewBox="0 0 64 64"/u);
  assert.match(identitySource, /\[forced-color-adjust:auto\]/u);
  assert.match(identitySource, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(identitySource, /animation: none !important/u);
  assert.match(identitySource, /isMainAgentId\(agentId\)/u);

  const selectorSource = readProjectFile(
    'app/components/canvas-agent-chat/ChatAgentSelector.tsx',
  );
  assert.match(selectorSource, /testId = 'chat-agent-id'/u);
  assert.match(selectorSource, /<AgentIdentityIcon/u);
  assert.match(selectorSource, /<AgentIdentityAvatar/u);

  const starterSource = readProjectFile(
    'app/components/canvas-agent-chat/ChatStarterScreen.tsx',
  );
  assert.match(starterSource, /data-testid="bradley-starter-identity"/u);
  assert.match(starterSource, /alt=""/u);
  assert.match(starterSource, /aria-hidden="true"/u);
  assert.match(starterSource, /h-32 w-32[^']*md:h-36 md:w-36/u);
  assert.match(starterSource, /isMainAgentId\(activeAgentId\)/u);
  assert.match(starterSource, /!isStudioChatContext/u);

  const runtimeSource = readProjectFile(
    'app/components/canvas-agent-chat/ChatRuntimeActivityBadge.tsx',
  );
  assert.match(runtimeSource, /data-testid="chat-runtime-busy-badge"/u);
  assert.match(runtimeSource, /role="status"/u);
  assert.match(runtimeSource, /aria-live="polite"/u);
  assert.match(runtimeSource, /isBradley && isWorking && !isAborting/u);
  assert.match(runtimeSource, /state=\{isPreparingResponse \? 'working' : 'idle'\}/u);

  const homeSource = readProjectFile('app/components/home/PromptHero.tsx');
  assert.match(homeSource, /testId="home-agent-id"/u);

  await verifyTransparentStarterAsset();
  console.log('bradley-ui-preflight-test: ok');
}

void main();
