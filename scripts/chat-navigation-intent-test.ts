import assert from 'node:assert/strict';

import {
  getChatNavigationIntent,
  getNotebookNavigationIntent,
} from '../app/lib/chat/chat-navigation-intent';

function params(value: string): URLSearchParams {
  return new URLSearchParams(value);
}

function main() {
  assert.deepEqual(getChatNavigationIntent(params('')), {
    sessionId: null,
    shouldOpenChat: false,
  });
  assert.deepEqual(getChatNavigationIntent(params('chat=open')), {
    sessionId: null,
    shouldOpenChat: true,
  });
  assert.deepEqual(getChatNavigationIntent(params('chat=closed&session=session-a')), {
    sessionId: 'session-a',
    shouldOpenChat: true,
  });
  assert.deepEqual(getChatNavigationIntent(params('session=%20%20')), {
    sessionId: null,
    shouldOpenChat: false,
  });
  assert.deepEqual(getNotebookNavigationIntent(params('path=%2Fdata%2Fworkspace%2Fdocs%2Fbrief.md&chat=open')), {
    path: 'docs/brief.md',
    sessionId: null,
    shouldOpenChat: true,
  });
  assert.deepEqual(getNotebookNavigationIntent(params('path=..%2Foutside.md&session=session-b')), {
    path: null,
    sessionId: 'session-b',
    shouldOpenChat: true,
  });

  console.log('chat-navigation-intent-test: ok');
}

main();
