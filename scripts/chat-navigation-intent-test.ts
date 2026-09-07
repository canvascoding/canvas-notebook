import assert from 'node:assert/strict';

import {
  NOTEBOOK_CHAT_HREF,
  NOTEBOOK_CHAT_PATH,
  buildChatSessionHref,
  buildNotebookChatRedirectHref,
  buildNotebookChatSessionHref,
  getChatNavigationIntent,
  getNotebookNavigationIntent,
} from '../app/lib/chat/chat-navigation-intent';
import { handleOpenChatSessionEvent } from '../app/lib/chat/open-chat-session-event';
import {
  clearWorkspaceScopedNavigationParams,
  getWorkspaceNavigationSyncAction,
  workspaceScopedNavigationMatches,
} from '../app/lib/workspaces/navigation-sync';

function params(value: string): URLSearchParams {
  return new URLSearchParams(value);
}

function main() {
  assert.deepEqual(getChatNavigationIntent(params('')), {
    sessionId: null,
    workspaceId: null,
    shouldOpenChat: false,
  });
  assert.deepEqual(getChatNavigationIntent(params('chat=open')), {
    sessionId: null,
    workspaceId: null,
    shouldOpenChat: true,
  });
  assert.deepEqual(getChatNavigationIntent(params('chat=closed&session=session-a')), {
    sessionId: 'session-a',
    workspaceId: null,
    shouldOpenChat: true,
  });
  assert.deepEqual(getChatNavigationIntent(params('session=%20%20')), {
    sessionId: null,
    workspaceId: null,
    shouldOpenChat: false,
  });
  assert.deepEqual(getChatNavigationIntent(params('session=session-a&workspaceId=workspace-a')), {
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    shouldOpenChat: true,
  });
  assert.deepEqual(getNotebookNavigationIntent(params('path=%2Fdata%2Fworkspace%2Fdocs%2Fbrief.md&chat=open')), {
    path: 'docs/brief.md',
    sessionId: null,
    workspaceId: null,
    shouldOpenChat: true,
  });
  assert.deepEqual(getNotebookNavigationIntent(params('path=..%2Foutside.md&session=session-b')), {
    path: null,
    sessionId: 'session-b',
    workspaceId: null,
    shouldOpenChat: true,
  });
  assert.equal(
    buildChatSessionHref(NOTEBOOK_CHAT_PATH, 'session-a', 'workspace-a'),
    '/notebook?session=session-a&workspaceId=workspace-a&chat=open',
  );
  assert.equal(NOTEBOOK_CHAT_HREF, '/notebook?chat=open');
  assert.equal(
    buildNotebookChatSessionHref('session-a', 'workspace-a'),
    '/notebook?session=session-a&workspaceId=workspace-a&chat=open',
  );
  assert.equal(
    buildNotebookChatRedirectHref({}),
    '/notebook?chat=open',
  );
  assert.equal(
    buildNotebookChatRedirectHref({
      session: 'session-a',
      workspaceId: 'workspace-a',
      chat: 'closed',
      filter: ['unread', 'assigned'],
      ignored: undefined,
    }),
    '/notebook?session=session-a&workspaceId=workspace-a&chat=open&filter=unread&filter=assigned',
  );
  assert.equal(
    buildChatSessionHref('/todos?todo=todo-a#details', 'session-a', 'workspace-a'),
    '/todos?todo=todo-a&session=session-a&workspaceId=workspace-a&chat=open#details',
  );

  assert.equal(getWorkspaceNavigationSyncAction({
    requestedWorkspaceId: 'workspace-a',
    activeWorkspaceId: 'workspace-a',
    requestKey: '/notebook?workspaceId=workspace-a&path=a.md',
    handledRequestKey: null,
  }), 'accept');
  assert.equal(getWorkspaceNavigationSyncAction({
    requestedWorkspaceId: 'workspace-a',
    activeWorkspaceId: 'workspace-b',
    requestKey: '/notebook?workspaceId=workspace-a&path=a.md',
    handledRequestKey: '/notebook?workspaceId=workspace-a&path=a.md',
  }), 'clear', 'a manual workspace change must supersede an already handled URL target');
  assert.equal(getWorkspaceNavigationSyncAction({
    requestedWorkspaceId: 'workspace-a',
    activeWorkspaceId: 'workspace-b',
    requestKey: '/notebook?workspaceId=workspace-a&path=a.md',
    handledRequestKey: null,
  }), 'switch', 'a new URL target must still select its workspace');
  assert.equal(
    clearWorkspaceScopedNavigationParams('?workspaceId=workspace-a&path=a.md&session=s1&chat=open&filter=recent'),
    'chat=open&filter=recent',
  );
  assert.equal(workspaceScopedNavigationMatches('workspace-a', 'workspace-b'), false);
  assert.equal(workspaceScopedNavigationMatches('workspace-b', 'workspace-b'), true);
  assert.equal(workspaceScopedNavigationMatches(null, 'workspace-b'), true);

  const event = new CustomEvent('canvas:open-chat-session', {
    detail: { sessionId: 'session-a', workspaceId: 'workspace-a', handled: false },
  });
  let switchedWorkspaceId: string | null = null;
  let openedSessionId: string | null = null;
  assert.equal(handleOpenChatSessionEvent(event, {
    activeWorkspaceId: 'workspace-b',
    switchWorkspace: (workspaceId) => {
      switchedWorkspaceId = workspaceId;
      return true;
    },
    openSession: (sessionId) => {
      openedSessionId = sessionId;
    },
  }), true);
  assert.equal(switchedWorkspaceId, 'workspace-a');
  assert.equal(openedSessionId, 'session-a');
  assert.equal(event.detail.handled, true);

  console.log('chat-navigation-intent-test: ok');
}

main();
