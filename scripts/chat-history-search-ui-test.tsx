import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatHistoryPanel } from '../app/components/canvas-agent-chat/ChatHistoryPanel';
import type { AISession, ChatHistoryGroups } from '../app/lib/chat/types';

const titleSession: AISession = {
  id: 1,
  sessionId: 'sess-title',
  title: 'Quarterly launch',
  agentId: 'bradley',
  model: 'test',
  createdAt: '2026-09-01T10:00:00.000Z',
  engine: 'pi',
};
const contentSession: AISession = {
  id: 2,
  sessionId: 'sess-content',
  title: 'Creative review',
  agentId: 'bradley',
  model: 'test',
  createdAt: '2026-09-04T10:00:00.000Z',
  engine: 'pi',
};
const filteredHistory: ChatHistoryGroups = {
  searchTitle: [titleSession],
  searchContent: [contentSession],
  today: [],
  last7: [],
  last14: [],
  last30: [],
  older: [],
};

const html = renderToStaticMarkup(
  <ChatHistoryPanel
    variant="sidebar"
    history={[titleSession, contentSession]}
    filteredHistory={filteredHistory}
    historySearchQuery="quarterly"
    historySearchMatchesBySessionId={new Map([
      ['sess-title', { kind: 'title' as const }],
      ['sess-content', {
        kind: 'content' as const,
        messageId: 42,
        role: 'assistant',
        snippet: 'The quarterly campaign uses blue.',
      }],
    ])}
    isSearchingHistory={false}
    historyUnreadOnly={false}
    historyAgentFilter="all"
    historyAgentOptions={[]}
    totalUnreadCount={0}
    currentSessionId={null}
    agentProfilesById={new Map()}
    groupLabels={{
      searchTitle: 'Title matches',
      searchContent: 'Matches in chats',
      today: 'Today',
      last7: 'Last 7 days',
      last14: 'Last 14 days',
      last30: 'Last 30 days',
      older: 'Older',
    }}
    labels={{
      chatHistory: 'Chat history',
      searchSessions: 'Search sessions...',
      searchingSessions: 'Searching chat history',
      matchInChat: 'In chat:',
      filterAllAgents: 'All agents',
      filterUnreadOnly: 'Unread only',
      filterAllSessions: 'All sessions',
      markAllAsRead: 'Mark all as read',
      backToChat: 'Back',
      noRecentSessions: 'No sessions',
      noSessionsFoundWithFilter: 'No matches',
      newChatTitle: 'New chat',
      sessionTitleGenerating: 'Generating',
      unreadResponse: 'Unread',
      renameSession: 'Rename',
      markAsUnread: 'Mark unread',
      deleteSession: 'Delete',
    }}
    onSearchQueryChange={() => undefined}
    onUnreadOnlyChange={() => undefined}
    onAgentFilterChange={() => undefined}
    onMarkAllAsRead={() => undefined}
    onLoadSession={() => undefined}
    onRenameSession={() => undefined}
    onMarkSessionAsUnread={() => undefined}
    onDeleteSession={() => undefined}
  />,
);

assert.ok(html.indexOf('Title matches') < html.indexOf('Matches in chats'));
assert.ok(html.indexOf('Quarterly launch') < html.indexOf('Creative review'));
assert.match(html, /In chat:/);
assert.match(html, /The quarterly campaign uses blue\./);

console.log('chat-history-search-ui-test: ok');
