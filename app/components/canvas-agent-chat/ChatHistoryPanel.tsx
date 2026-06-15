'use client';

import { useState } from 'react';
import {
  CheckCheck,
  ChevronLeft,
  Eye,
  EyeOff,
  History,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { AgentAvatar, AgentIcon } from '@/app/components/agents/AgentAvatar';
import { getAgentDisplayName } from '@/app/lib/chat/agent-display';
import { getSessionDisplayTitle } from '@/app/lib/pi/session-titles';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import type {
  AgentProfile,
  AISession,
  ChatHistoryAgentOption,
  ChatHistoryGroup,
  ChatHistoryGroups,
  ChatHistoryPanelVariant,
} from '@/app/lib/chat/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const CHAT_HISTORY_GROUP_ORDER: ChatHistoryGroup[] = ['today', 'last7', 'last14', 'last30', 'older'];

type ChatHistorySessionRowProps = {
  session: AISession;
  isActive: boolean;
  agentProfile?: AgentProfile;
  agentName: string;
  newChatTitle: string;
  unreadResponseLabel: string;
  renameSessionLabel: string;
  deleteSessionLabel: string;
  onLoadSession: (session: AISession) => void | Promise<void>;
  onRenameSession: (session: AISession) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
};

function getHistoryAgentAvatarClassName(session: AISession): string {
  switch (session.runtimePhase) {
    case 'aborting':
      return 'border-rose-500/50 bg-rose-500/15 text-rose-700 ring-2 ring-rose-500/20 dark:text-rose-300';
    case 'running_tool':
      return 'border-amber-500/60 bg-amber-500/20 text-amber-800 ring-2 ring-amber-500/30 dark:text-amber-200';
    case 'streaming':
      return 'border-amber-500/45 bg-amber-500/15 text-amber-700 ring-2 ring-amber-500/20 dark:text-amber-300';
    default:
      return 'bg-background/80';
  }
}

function ChatHistorySessionRow({
  session,
  isActive,
  agentProfile,
  agentName,
  newChatTitle,
  unreadResponseLabel,
  renameSessionLabel,
  deleteSessionLabel,
  onLoadSession,
  onRenameSession,
  onDeleteSession,
}: ChatHistorySessionRowProps) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const createdAtLabel = new Date(session.createdAt).toLocaleString();

  return (
    <div
      className={cn(
        'group mb-2 flex w-full items-start gap-2 rounded-md border p-2.5 transition-all',
        isActive
          ? 'border-primary/35 bg-primary/10 shadow-sm'
          : 'border-transparent bg-muted/25 hover:border-border hover:bg-accent/80',
      )}
    >
      <button
        type="button"
        onClick={() => { void onLoadSession(session); }}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
      >
        <span className="relative mt-0.5 shrink-0">
          <AgentAvatar
            iconId={agentProfile?.iconId}
            className={cn('h-8 w-8 rounded-md', getHistoryAgentAvatarClassName(session))}
            iconClassName="h-4 w-4"
          />
          {session.hasUnread && (
            <span
              data-testid="chat-history-unread-indicator"
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-blue-500"
              title={unreadResponseLabel}
              aria-label={unreadResponseLabel}
            />
          )}
        </span>
        <div className="min-w-0 flex-1 text-left">
          <div
            className={cn(
              'min-w-0 truncate text-sm font-semibold leading-5',
              isActive ? 'text-primary' : 'text-foreground group-hover:text-primary',
            )}
          >
            {getSessionDisplayTitle(session.title, newChatTitle)}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-4 text-muted-foreground">
            <span className="max-w-full truncate">{createdAtLabel}</span>
            <span className="inline-flex max-w-full min-w-0 items-center gap-1">
              <AgentIcon iconId={agentProfile?.iconId} className="h-3 w-3 shrink-0" />
              <span className="min-w-0 max-w-[9rem] truncate">{agentName}</span>
            </span>
          </div>
        </div>
      </button>
      <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background/80 hover:text-foreground"
            title={`${renameSessionLabel} / ${deleteSessionLabel}`}
            aria-label={`${renameSessionLabel} / ${deleteSessionLabel}`}
          >
            <MoreHorizontal size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" className="w-44 p-1">
          <button
            type="button"
            onClick={() => {
              setActionsOpen(false);
              void onRenameSession(session);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Pencil size={14} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{renameSessionLabel}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActionsOpen(false);
              void onDeleteSession(session.sessionId);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 size={14} className="shrink-0" />
            <span className="min-w-0 truncate">{deleteSessionLabel}</span>
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export type ChatHistoryPanelLabels = {
  chatHistory: string;
  searchSessions: string;
  filterAllAgents: string;
  filterUnreadOnly: string;
  filterAllSessions: string;
  markAllAsRead: string;
  backToChat: string;
  noRecentSessions: string;
  noSessionsFoundWithFilter: string;
  newChatTitle: string;
  unreadResponse: string;
  renameSession: string;
  deleteSession: string;
};

export type ChatHistoryPanelProps = {
  variant: ChatHistoryPanelVariant;
  width?: number;
  history: AISession[];
  filteredHistory: ChatHistoryGroups;
  historySearchQuery: string;
  historyUnreadOnly: boolean;
  historyAgentFilter: string;
  historyAgentOptions: ChatHistoryAgentOption[];
  totalUnreadCount: number;
  currentSessionId: string | null;
  agentProfilesById: Map<string, AgentProfile>;
  groupLabels: Record<ChatHistoryGroup, string>;
  labels: ChatHistoryPanelLabels;
  onSearchQueryChange: (value: string) => void;
  onUnreadOnlyChange: (value: boolean) => void;
  onAgentFilterChange: (value: string) => void;
  onMarkAllAsRead: () => void | Promise<void>;
  onBackToChat?: () => void;
  onLoadSession: (session: AISession) => void | Promise<void>;
  onRenameSession: (session: AISession) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
};

export function ChatHistoryPanel({
  variant,
  width,
  history,
  filteredHistory,
  historySearchQuery,
  historyUnreadOnly,
  historyAgentFilter,
  historyAgentOptions,
  totalUnreadCount,
  currentSessionId,
  agentProfilesById,
  groupLabels,
  labels,
  onSearchQueryChange,
  onUnreadOnlyChange,
  onAgentFilterChange,
  onMarkAllAsRead,
  onBackToChat,
  onLoadSession,
  onRenameSession,
  onDeleteSession,
}: ChatHistoryPanelProps) {
  const isOverlay = variant === 'overlay';
  const hasActiveFilter = historySearchQuery.trim().length > 0 || historyUnreadOnly || historyAgentFilter !== 'all';
  const hasFilteredSessions = CHAT_HISTORY_GROUP_ORDER.some((group) => filteredHistory[group].length > 0);

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden',
        isOverlay
          ? 'absolute inset-0 z-20 bg-background'
          : 'flex-shrink-0 border-r border-border bg-card',
      )}
      style={!isOverlay && width ? { width: `${width}px` } : undefined}
    >
      <div className="shrink-0 space-y-3 border-b border-border bg-background/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <History size={14} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {labels.chatHistory}
            </span>
          </div>
          {isOverlay && onBackToChat ? (
            <button
              type="button"
              onClick={onBackToChat}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-muted/30 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft size={12} />
              <span className="max-w-[9rem] truncate">{labels.backToChat}</span>
            </button>
          ) : null}
        </div>

        <div className="relative">
          <input
            type="text"
            value={historySearchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder={labels.searchSessions}
            className="h-10 w-full rounded-md border border-border bg-background px-3 pl-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => onAgentFilterChange('all')}
            className={cn(
              'inline-flex h-8 shrink-0 items-center rounded-md border px-2.5 text-[11px] font-medium transition-colors',
              historyAgentFilter === 'all'
                ? 'border-primary/30 bg-primary/15 text-primary'
                : 'border-border bg-muted/30 text-muted-foreground',
            )}
          >
            {labels.filterAllAgents}
          </button>
          {historyAgentOptions.map((agent) => (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => onAgentFilterChange(agent.agentId)}
              className={cn(
                'inline-flex h-8 max-w-[12rem] shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-colors',
                historyAgentFilter === agent.agentId
                  ? 'border-primary/30 bg-primary/15 text-primary'
                  : 'border-border bg-muted/30 text-muted-foreground',
              )}
              title={agent.agentId}
            >
              <AgentIcon iconId={agent.iconId} className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{agent.name}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onUnreadOnlyChange(!historyUnreadOnly)}
            className={cn(
              'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors',
              historyUnreadOnly
                ? 'border-primary/30 bg-primary/15 text-primary'
                : 'border-border bg-muted/30 text-muted-foreground',
            )}
          >
            {historyUnreadOnly ? <Eye size={12} /> : <EyeOff size={12} />}
            <span className="truncate">{historyUnreadOnly ? labels.filterUnreadOnly : labels.filterAllSessions}</span>
          </button>
          {totalUnreadCount > 0 ? (
            <button
              type="button"
              onClick={() => { void onMarkAllAsRead(); }}
              className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/15 hover:text-primary"
            >
              <CheckCheck size={12} />
              <span className="truncate">{labels.markAllAsRead}</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className={cn('flex-1 overflow-y-auto p-2.5', isOverlay ? 'pb-[calc(env(safe-area-inset-bottom)+0.75rem)]' : null)}>
        {history.length === 0 ? (
          <div className="p-8 text-center text-sm italic text-muted-foreground">
            {labels.noRecentSessions}
          </div>
        ) : null}

        {CHAT_HISTORY_GROUP_ORDER.map((group) => {
          const sessions = filteredHistory[group];
          if (sessions.length === 0) return null;

          return (
            <div key={group} className="mb-4">
              <div className="mb-2 px-2 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                {groupLabels[group]} ({sessions.length})
              </div>
              {sessions.map((session) => {
                const isActive = currentSessionId === session.sessionId;
                const sessionAgentId = session.agentId || DEFAULT_AGENT_ID;
                const sessionAgentProfile = agentProfilesById.get(sessionAgentId);
                const sessionAgentName = sessionAgentProfile?.name || getAgentDisplayName(session.agentId);

                return (
                  <ChatHistorySessionRow
                    key={session.id}
                    session={session}
                    isActive={isActive}
                    agentProfile={sessionAgentProfile}
                    agentName={sessionAgentName}
                    newChatTitle={labels.newChatTitle}
                    unreadResponseLabel={labels.unreadResponse}
                    renameSessionLabel={labels.renameSession}
                    deleteSessionLabel={labels.deleteSession}
                    onLoadSession={onLoadSession}
                    onRenameSession={onRenameSession}
                    onDeleteSession={onDeleteSession}
                  />
                );
              })}
            </div>
          );
        })}

        {history.length > 0 && !hasFilteredSessions ? (
          <div className="p-8 text-center text-sm italic text-muted-foreground">
            {hasActiveFilter ? labels.noSessionsFoundWithFilter : labels.noRecentSessions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
