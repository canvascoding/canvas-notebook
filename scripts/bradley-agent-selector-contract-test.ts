import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  getAgentDisplayName,
  getAgentProfileDisplayName,
} from '../app/lib/chat/agent-display';

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function main(): void {
  assert.equal(getAgentProfileDisplayName('canvas-agent', 'Canvas Agent'), 'Bradley');
  assert.equal(getAgentProfileDisplayName('canvas-agent', 'Studio Companion'), 'Bradley');
  assert.equal(getAgentProfileDisplayName('canvas-agent', null), 'Bradley');
  assert.equal(getAgentProfileDisplayName('research-agent', 'Research Atlas'), 'Research Atlas');
  assert.equal(getAgentProfileDisplayName('research-agent', '  Research Atlas  '), 'Research Atlas');
  assert.equal(getAgentProfileDisplayName('research-agent', ''), 'Research Agent');
  assert.equal(getAgentDisplayName('canvas-agent'), 'Bradley');

  const chatSource = readProjectFile('app/components/canvas-agent-chat/CanvasAgentChat.tsx');
  assert.match(
    chatSource,
    /activeAgentDisplayName = getAgentProfileDisplayName\(activeSessionAgentId, activeAgentProfile\?\.name\)/u,
  );
  assert.match(chatSource, /name: getAgentProfileDisplayName\(agent\.agentId, agent\.name\)/u);

  const homeSource = readProjectFile('app/components/home/PromptHero.tsx');
  assert.match(
    homeSource,
    /selectedAgentName = getAgentProfileDisplayName\(effectiveSelectedAgentId, selectedAgent\?\.name\)/u,
  );
  assert.match(homeSource, /name: getAgentProfileDisplayName\(agent\.agentId, agent\.name\)/u);

  const selectorSource = readProjectFile('app/components/canvas-agent-chat/ChatAgentSelector.tsx');
  assert.match(selectorSource, /<AgentIcon iconId=\{activeAgentIconId\}/u);
  assert.match(selectorSource, /<AgentAvatar iconId=\{agent\.iconId\}/u);
  assert.match(selectorSource, /\{agent\.name\}/u);

  console.log('bradley-agent-selector-contract-test: ok');
}

main();
