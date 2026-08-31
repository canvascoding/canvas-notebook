import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MAIN_AGENT_DISPLAY_NAME } from '../app/lib/agents/main-agent';
import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';
import { getAgentDisplayName } from '../app/lib/chat/agent-display';

assert.equal(MAIN_AGENT_DISPLAY_NAME, 'Bradley');
assert.equal(getAgentDisplayName(null), 'Bradley');
assert.equal(getAgentDisplayName(undefined), 'Bradley');
assert.equal(getAgentDisplayName(DEFAULT_AGENT_ID), 'Bradley');
assert.equal(getAgentDisplayName('research-agent'), 'Research Agent');

for (const relativePath of [
  'app/apps/automations/components/AutomationsClient.tsx',
  'app/components/canvas-agent-chat/CanvasAgentChat.tsx',
  'app/components/home/PromptHero.tsx',
]) {
  const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');
  assert.match(source, /MAIN_AGENT_DISPLAY_NAME/u, `${relativePath} must use the shared main-agent fallback.`);
  assert.doesNotMatch(source, /name:\s*['"]Canvas Agent['"]/u, `${relativePath} still contains the legacy fallback.`);
}

console.log('agent-display-fallbacks-test: ok');
