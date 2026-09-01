import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');
type Messages = {
  notebook: Record<string, unknown>;
  chat: Record<string, unknown>;
  settings: { agentPanel: Record<string, unknown> };
};
const en = JSON.parse(read('messages/en.json')) as Messages;
const de = JSON.parse(read('messages/de.json')) as Messages;

assert.equal(en.notebook.resizeChat, 'Resize Bradley chat');
assert.equal(en.chat.resizeHandleLabel, 'Resize Bradley chat');
assert.equal(de.notebook.resizeChat, 'Größe des Bradley-Chats ändern');
assert.equal(de.chat.resizeHandleLabel, 'Größe des Bradley-Chats ändern');

const enAgents = JSON.stringify(en.settings.agentPanel);
const deAgents = JSON.stringify(de.settings.agentPanel);
assert.match(enAgents, /Bradley/u);
assert.match(enAgents, /keeping their own identity/u);
assert.match(deAgents, /Bradley/u);
assert.match(deAgents, /eigene Identität/u);
assert.doesNotMatch(enAgents, /Canvas Agent/u);
assert.doesNotMatch(deAgents, /Canvas Agent/u);

assert.match(read('seed_sys_prompts/AGENTS.md'), /You are Bradley, the default main agent/u);
assert.doesNotMatch(read('seed_sys_prompts/SOUL.md'), /canvas-agent|Canvas Agent|Bradley/u);

const matches = execFileSync('rg', [
  '-n',
  'Canvas Agent',
  'app',
  'messages',
  'seed_sys_prompts',
  '--glob',
  '*.{ts,tsx,json,md}',
], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
assert.deepEqual(matches, [
  "app/lib/agents/registry.ts:16:const LEGACY_MAIN_AGENT_DISPLAY_NAMES = new Set(['Canvas Agent']);",
]);

console.log('bradley-visible-copy-test: ok');
