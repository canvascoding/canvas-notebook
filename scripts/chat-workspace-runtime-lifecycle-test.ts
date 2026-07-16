import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const sessionStorage = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = { sessionStorage };

async function main() {
  const {
    clearCanvasChatActiveSessionStorage,
    readCanvasChatActiveSessionStorage,
    writeCanvasChatActiveSessionStorage,
  } = await import('../app/lib/chat/constants');

  writeCanvasChatActiveSessionStorage('workspace-a', 'session-running-a');
  writeCanvasChatActiveSessionStorage('workspace-b', 'session-b');

  assert.equal(readCanvasChatActiveSessionStorage('workspace-a'), 'session-running-a');
  assert.equal(readCanvasChatActiveSessionStorage('workspace-b'), 'session-b');

  clearCanvasChatActiveSessionStorage('workspace-b');
  assert.equal(readCanvasChatActiveSessionStorage('workspace-a'), 'session-running-a');
  assert.equal(readCanvasChatActiveSessionStorage('workspace-b'), null);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const canvasAgentChat = readFileSync(
    path.join(root, 'app/components/canvas-agent-chat/CanvasAgentChat.tsx'),
    'utf8',
  );
  const chatControlActions = readFileSync(
    path.join(root, 'app/components/canvas-agent-chat/useChatControlActions.ts'),
    'utf8',
  );
  const channelRouter = readFileSync(
    path.join(root, 'app/lib/channels/router.ts'),
    'utf8',
  );
  const websocketServer = readFileSync(
    path.join(root, 'server/websocket-server.ts'),
    'utf8',
  );

  assert.match(
    canvasAgentChat,
    /clearCanvasChatActiveSessionStorage\(detail\.activeWorkspaceId\)/u,
    'workspace changes must clear the target workspace resume pointer so the UI starts a new chat',
  );
  assert.doesNotMatch(
    canvasAgentChat,
    /clearCanvasChatActiveSessionStorage\(detail\.previousWorkspaceId\)/u,
    'workspace changes must retain the previous workspace resume pointer',
  );
  assert.match(
    chatControlActions,
    /writeCanvasChatActiveSessionStorage\(currentSessionWorkspaceId \?\? activeWorkspaceId, currentSessionId\)/u,
    'the current session must be persisted under its own workspace before the UI detaches',
  );
  assert.match(
    chatControlActions,
    /userStartedNewChatRef\.current = true/u,
    'a workspace transition must keep the new workspace on a blank chat',
  );
  assert.doesNotMatch(
    canvasAgentChat,
    /restoreWorkspaceSession:\s*true/u,
    'workspace changes must not restore a previous chat in the target workspace',
  );
  assert.match(
    chatControlActions,
    /agentId:\s*sessionAgentIdRef\.current \|\| selectedAgentId/u,
    'the selected session agent must be sent with the first WebSocket message',
  );
  assert.match(
    websocketServer,
    /const agentId = existingSession\?\.agentId \|\| requestedAgentId[\s\S]*requestedSessionId:\s*message\.sessionId,[\s\S]*agentId,/u,
    'the WebSocket server must prefer the stored session agent and forward it with the requested session',
  );
  assert.match(
    channelRouter,
    /requestedSessionId:\s*message\.requestedSessionId,[\s\S]*agentId:\s*message\.agentId/u,
    'the channel router must preserve the selected agent during session resolution',
  );

  const unsubscribeStart = websocketServer.indexOf("case 'unsubscribe_session':");
  const unsubscribeEnd = websocketServer.indexOf("case 'send_message':", unsubscribeStart);
  assert.notEqual(unsubscribeStart, -1);
  assert.notEqual(unsubscribeEnd, -1);
  const unsubscribeHandler = websocketServer.slice(unsubscribeStart, unsubscribeEnd);
  assert.doesNotMatch(
    unsubscribeHandler,
    /abort|invalidateRuntime|dispose/u,
    'unsubscribing the UI must never stop or dispose the server-side runtime',
  );

  console.log('chat-workspace-runtime-lifecycle-test: ok');
}

void main();
