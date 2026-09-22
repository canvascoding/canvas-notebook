import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observeOpenedDocumentAuth, openedDocumentAuthScope, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { buildCachedChatSessionEntry, rememberChatSessionCacheEntry, persistChatSessionCache, readCachedChatSession, readLatestCachedChatSession, updateCachedChatSessionTitle, removeCachedChatSession } from '../app/lib/chat/session-cache';
import type { AISession } from '../app/lib/chat/types';

const key = 'canvas.chat.sessionMessages.v2';
const legacyKey = 'canvas.chat.sessionMessages.v1';
const dom = new JSDOM('', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window });
const session: AISession = { id: 1, sessionId: 'shared-chat', agentId: 'bradley', model: '', title: 'Private title', createdAt: new Date().toISOString(),
  workspace: { workspaceId: 'shared-workspace', workspaceType: 'team', workspaceName: 'Shared', organizationId: 'org', rootRelativePath: null, legacy: false } };
const build = (authScope = openedDocumentAuthScope()) => buildCachedChatSessionEntry({ authScope, session,
  messages: [{ id: '1', role: 'user', content: 'Private content' }], hasMoreBefore: false, oldestTimestamp: null, oldestMessageId: 1, oldestSequence: 1 });
const auth = (userId: string, sessionId: string) => observeOpenedDocumentAuth({ data: { user: { id: userId }, session: { id: sessionId } } });
const storage = dom.window.sessionStorage;
try {
  const beforeAuth = build();
  storage.setItem(legacyKey, JSON.stringify({ version: 1, entries: [beforeAuth] }));
  storage.setItem(key, JSON.stringify({ version: 2, auth: { userId: 'alice', sessionId: 'alice-session' }, entries: [beforeAuth] }));
  rememberChatSessionCacheEntry(beforeAuth);
  persistChatSessionCache();
  assert.equal(readLatestCachedChatSession(session.sessionId), null, 'no transcript before auth hydration');
  auth('alice', 'alice-session');
  assert.equal(readCachedChatSession('bradley', session.sessionId)?.messages[0].content, 'Private content', 'same user and auth session restore persisted snapshot');
  assert.equal(storage.getItem(legacyKey), null, 'unscoped legacy cache is discarded');
  updateCachedChatSessionTitle(session.sessionId, 'Renamed');
  assert.equal(JSON.parse(storage.getItem(key)!).entries[0].session.title, 'Renamed');
  const aliceScope = openedDocumentAuthScope();
  const aliceEntry = build();
  auth('bob', 'bob-session');
  assert.equal(storage.getItem(key), null, 'account switch immediately purges persisted transcript');
  assert.equal(readLatestCachedChatSession(session.sessionId), null, 'shared workspace does not grant cache access');
  rememberChatSessionCacheEntry(aliceEntry);
  rememberChatSessionCacheEntry(build(aliceScope));
  rememberChatSessionCacheEntry(beforeAuth);
  assert.equal(readLatestCachedChatSession(session.sessionId), null, 'old effects and pre-hydration entries cannot fill a new scope');
  rememberChatSessionCacheEntry(build());
  persistChatSessionCache();
  assert.equal(JSON.parse(storage.getItem(key)!).auth.userId, 'bob');
  auth('bob', 'bob-new-session');
  assert.equal(readLatestCachedChatSession(session.sessionId), null, 'same user with a new auth session starts empty');
  const oldEpochEntry = build();
  rememberChatSessionCacheEntry(oldEpochEntry);
  persistChatSessionCache();
  invalidateOpenedDocumentAuth();
  rememberChatSessionCacheEntry(oldEpochEntry);
  assert.equal(readLatestCachedChatSession(session.sessionId), null, 'auth invalidation revokes same-identity RAM epoch');
  assert.equal(storage.getItem(key), null);
  // Simulate stale storage from a different session being present before hydration.
  invalidateOpenedDocumentAuth();
  storage.setItem(key, JSON.stringify({ version: 2, auth: { userId: 'alice', sessionId: 'alice-session' }, entries: [aliceEntry] }));
  assert.equal(readLatestCachedChatSession(session.sessionId), null);
  assert.equal(storage.getItem(key), null, 'mismatched persisted auth scope is removed');
  rememberChatSessionCacheEntry(build());
  removeCachedChatSession(session.sessionId);
  assert.equal(readLatestCachedChatSession(session.sessionId), null);
  observeOpenedDocumentAuth(null);
  rememberChatSessionCacheEntry(build());
  persistChatSessionCache();
  assert.equal(storage.getItem(key), null, 'logout prevents further persisted writes');
  console.log('chat-session-cache-scope-test: ok');
} finally { dom.window.close(); }
