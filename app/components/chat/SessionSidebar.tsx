'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import {
  History,
  Search,
  Eye,
  EyeOff,
  Pencil,
  Trash2,
  MessageSquare,
  ChevronLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSessionDisplayTitle } from '@/app/lib/pi/session-titles';

export interface AISession {
  id: number;
  sessionId: string;
  title: string;
  model: string;
  createdAt: string;
  engine?: 'legacy' | 'pi';
  lastMessageAt?: string | null;
  lastViewedAt?: string | null;
  hasUnread?: boolean;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
}

interface SessionSidebarProps {
  currentSessionId?: string | null;
  onSessionSelect: (session: AISession) => void;
  sidebarWidth: number;
  isMobile?: boolean;
  onClose?: () => void;
  onToggleSidebar?: () => void;
}

type SessionGroup = 'today' | 'last7' | 'last14' | 'last30' | 'older';

export function SessionSidebar({
  currentSessionId,
  onSessionSelect,
  sidebarWidth,
  isMobile = false,
  onClose,
  onToggleSidebar,
}: SessionSidebarProps) {
  const t = useTranslations('chat');
  const [history, setHistory] = useState<AISession[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (data.success) {
        setHistory(data.sessions || []);
      }
    } catch (err) {
      console.error('Failed to fetch history', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  const getSessionTimeGroup = useCallback((dateString: string): SessionGroup => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'today';
    if (diffDays <= 7) return 'last7';
    if (diffDays <= 14) return 'last14';
    if (diffDays <= 30) return 'last30';
    return 'older';
  }, []);

  const filteredHistory = React.useMemo(() => {
    let filtered = history;
    
    if (unreadOnly) {
      filtered = filtered.filter(s => s.hasUnread);
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(s => 
        s.title?.toLowerCase().includes(query) || 
        s.sessionId.toLowerCase().includes(query)
      );
    }
    
    filtered.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.createdAt).getTime();
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
    
    const grouped: Record<SessionGroup, AISession[]> = {
      today: [],
      last7: [],
      last14: [],
      last30: [],
      older: [],
    };
    
    filtered.forEach(session => {
      const group = getSessionTimeGroup(session.createdAt);
      grouped[group].push(session);
    });
    
    return grouped;
  }, [history, searchQuery, unreadOnly, getSessionTimeGroup]);

  const deleteSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!confirm(t('deleteSessionConfirm'))) return;

    try {
      const res = await fetch(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setHistory((prev) => prev.filter((session) => session.sessionId !== sessionId));
      }
    } catch (err) {
      console.error('Failed to delete session', err);
    }
  }, [t]);

  const renameSession = useCallback(async (e: React.MouseEvent, session: AISession) => {
    e.stopPropagation();
    const nextTitle = prompt(t('renameSessionPrompt'), getSessionDisplayTitle(session.title, t('newChatTitle')));
    if (!nextTitle || !nextTitle.trim()) return;

    try {
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, title: nextTitle.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setHistory((prev) => prev.map((item) => 
          item.sessionId === session.sessionId ? { ...item, title: nextTitle.trim() } : item
        ));
      }
    } catch (err) {
      console.error('Failed to rename session', err);
    }
  }, [t]);

  const handleSessionClick = useCallback((session: AISession) => {
    onSessionSelect(session);
    // Dispatch event for parent components
    window.dispatchEvent(
      new CustomEvent('chat-session-selected', {
        detail: { sessionId: session.sessionId },
      })
    );
    if (isMobile && onClose) {
      onClose();
    }
  }, [onSessionSelect, isMobile, onClose]);

  const groupLabels = {
    today: t('groupToday'),
    last7: t('groupLast7Days'),
    last14: t('groupLast14Days'),
    last30: t('groupLast30Days'),
    older: t('groupOlder'),
  };

  return (
    <div 
      className="flex h-full flex-col border-r border-border bg-card"
      style={{ width: `${sidebarWidth}px` }}
    >
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          {isMobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              className="mr-1"
            >
              <ChevronLeft size={16} />
            </Button>
          )}
          {!isMobile && onToggleSidebar && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleSidebar}
              className="shrink-0"
              title={t('collapseSidebar')}
            >
              <ChevronLeft size={16} />
            </Button>
          )}
        </div>
        {!isMobile && (
          <Link
            href="/notebook"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t('openNotebook')}
          >
            <MessageSquare size={14} />
          </Link>
        )}
      </div>

      {/* Search & Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('searchSessions')}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 pl-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Search 
            size={14} 
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" 
          />
        </div>
        
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setUnreadOnly(!unreadOnly)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
              unreadOnly 
                ? 'border-primary/30 bg-primary/15 text-primary' 
                : 'border-border bg-muted/30 text-muted-foreground'
            }`}
          >
            {unreadOnly ? <Eye size={12} /> : <EyeOff size={12} />}
            {unreadOnly ? t('filterUnreadOnly') : t('filterAllSessions')}
          </button>
          {isMobile && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              {history.length} {t('sessions')}
            </span>
          )}
        </div>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <History className="mr-2 h-4 w-4 animate-spin" />
            {t('loadingSessions')}
          </div>
        ) : history.length === 0 ? (
          <div className="py-8 text-center text-sm italic text-muted-foreground">
            {t('noRecentSessions')}
          </div>
        ) : (
          <>
            {Object.entries(filteredHistory).map(([group, sessions]) => {
              if (sessions.length === 0) return null;
              
              return (
                <div key={group} className="mb-4">
                  <div className="mb-2 px-2 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                    {groupLabels[group as keyof typeof groupLabels]} ({sessions.length})
                  </div>
                  {sessions.map((session) => {
                    const isActive = currentSessionId === session.sessionId;
                    return (
                      <div 
                        key={session.id} 
                        className={`group mb-1 flex w-full items-center rounded-md border p-2 transition-all ${
                          isActive 
                            ? 'border-primary/30 bg-primary/10' 
                            : 'border-transparent bg-muted/30 hover:border-border hover:bg-accent'
                        }`}
                      >
                        <button 
                          type="button" 
                          onClick={() => handleSessionClick(session)} 
                          className="min-w-0 flex-1 text-left flex items-start gap-2"
                        >
                          {session.hasUnread && (
                            <div 
                              className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-500"
                              title={t('unreadResponse')}
                              aria-label={t('unreadResponse')}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className={`truncate text-sm font-medium ${
                              isActive ? 'text-primary' : 'text-foreground group-hover:text-primary'
                            }`}>
                              {getSessionDisplayTitle(session.title, t('newChatTitle'))}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                              <span>{new Date(session.createdAt).toLocaleString()}</span>
                              <span>&bull;</span>
                              <span>{session.model}</span>
                            </div>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => renameSession(e, session)}
                          className="ml-2 shrink-0 rounded-md border border-transparent p-1.5 text-muted-foreground transition-all hover:border-border hover:bg-accent"
                          title={t('renameSession')}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => deleteSession(e, session.sessionId)}
                          className="ml-1 shrink-0 rounded-md border border-transparent p-1.5 text-muted-foreground transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                          title={t('deleteSession')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            
            {Object.values(filteredHistory).every(group => group.length === 0) && (
              <div className="py-8 text-center text-sm italic text-muted-foreground">
                {searchQuery || unreadOnly 
                  ? t('noSessionsFoundWithFilter')
                  : t('noRecentSessions')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
