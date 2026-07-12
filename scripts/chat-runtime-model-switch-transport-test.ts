import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvasAgentChat = readFileSync(
  path.join(root, 'app/components/canvas-agent-chat/CanvasAgentChat.tsx'),
  'utf8',
);
const modelSelector = readFileSync(
  path.join(root, 'app/components/canvas-agent-chat/ChatModelSelector.tsx'),
  'utf8',
);
const websocketServer = readFileSync(
  path.join(root, 'server/websocket-server.ts'),
  'utf8',
);

assert.doesNotMatch(
  canvasAgentChat,
  /wsRequest\(\s*['"]change_model['"]/u,
  'a successful HTTP model PATCH must not trigger a second WebSocket invalidation',
);
assert.match(
  canvasAgentChat,
  /refreshRuntimeStatusAfterModelChange[\s\S]*await refreshRuntimeStatus\(currentSessionId\)/u,
  'the client should refresh status after the server-side runtime replacement',
);
assert.match(
  modelSelector,
  /await onRuntimeStatusRefresh\?\.\(\)/u,
  'the selector should request a status refresh after applying the PATCH response',
);
assert.doesNotMatch(
  websocketServer,
  /change_model/u,
  'the obsolete unsafe WebSocket model invalidation command must remain removed',
);

console.log('chat-runtime-model-switch-transport-test: ok');
