'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import {
  Bot,
  Clipboard,
  Code,
  Maximize2,
  Minimize2,
  OctagonX,
  Plus,
  Skull,
  TextSelect,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { useTerminalStore } from '@/app/store/terminal-store';
import { cn } from '@/lib/utils';

const MAX_TERMINAL_SESSIONS = 4;
const SAFE_MAX_TERMINAL_SESSIONS =
  Number.isFinite(MAX_TERMINAL_SESSIONS) && MAX_TERMINAL_SESSIONS > 0
    ? MAX_TERMINAL_SESSIONS
    : 4;

// Dynamic import to prevent SSR issues with xterm.js
const XTerminal = dynamic(() => import('./XTerminal').then(mod => ({ default: mod.XTerminal })), {
  ssr: false,
  loading: () => null,
});

interface TerminalPanelProps {
  standalone?: boolean;
  className?: string;
}

export function TerminalPanel({ standalone = false, className }: TerminalPanelProps = {}) {
  const t = useTranslations('terminal');
  const {
    sessions,
    activeSessionId,
    hydrated,
    createSession,
    closeSession,
    clearSessions,
    setActiveSession,
    setHydrated,
  } = useTerminalStore();
  const [selectMode, setSelectMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isKilling, setIsKilling] = useState(false);
  const didAutoCreateOnMountRef = useRef(false);

  useEffect(() => {
    if (useTerminalStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    const unsubscribe = useTerminalStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return unsubscribe;
  }, [setHydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (didAutoCreateOnMountRef.current) return;
    didAutoCreateOnMountRef.current = true;
    if (sessions.length === 0) {
      createSession();
    }
  }, [hydrated, sessions.length, createSession]);

  const closeSessionEverywhere = useCallback(async (id: string) => {
    closeSession(id);
    try {
      await fetch(`/api/terminal/${id}`, { method: 'DELETE' });
    } catch (error) {
      console.warn('[Terminal] Failed to release session on server', error);
    }
  }, [closeSession]);

  const handleCreateSession = useCallback(() => {
    if (sessions.length >= SAFE_MAX_TERMINAL_SESSIONS) {
      toast.error(t('maxSessionsReached', { count: SAFE_MAX_TERMINAL_SESSIONS }));
      return;
    }
    createSession();
  }, [createSession, sessions.length, t]);

  useEffect(() => {
    if (!hydrated) return;
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSession(sessions[0].id);
    }
  }, [hydrated, sessions, activeSessionId, setActiveSession]);

  useEffect(() => {
    if (!hydrated) return;
    if (sessions.length > SAFE_MAX_TERMINAL_SESSIONS) {
      sessions.slice(SAFE_MAX_TERMINAL_SESSIONS).forEach((session) => {
        void closeSessionEverywhere(session.id);
      });
    }
  }, [hydrated, sessions, closeSessionEverywhere]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      // Only intercept Ctrl+T if target is not in terminal
      const target = event.target as HTMLElement;
      const isInTerminal = target.closest('.xterm, .xterm-screen');

      if (!isInTerminal && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
        event.preventDefault();
        handleCreateSession();
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [handleCreateSession]);

  useEffect(() => {
    const handleFullscreen = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { enabled?: boolean } | undefined;
      if (typeof detail?.enabled === 'boolean') {
        setIsFullscreen(detail.enabled);
      }
    };
    window.addEventListener('terminal-fullscreen-state', handleFullscreen as EventListener);
    return () => {
      window.removeEventListener('terminal-fullscreen-state', handleFullscreen as EventListener);
    };
  }, []);

  const handleKillAll = async () => {
    if (isKilling) return;
    const confirmed = window.confirm(t('killAllConfirm'));
    if (!confirmed) return;
    setIsKilling(true);
    try {
      const response = await fetch('/api/terminal/kill', { method: 'POST' });
      if (!response.ok) {
        throw new Error(t('failedToResetTerminals'));
      }
      const result = await response.json() as { closed?: number };
      clearSessions();
      setSelectMode(false);
      const closed = typeof result.closed === 'number' ? result.closed : 0;
      toast.success(
        closed > 0
          ? t('sessionsResetCount', { count: closed, suffix: closed === 1 ? '' : 's' })
          : t('sessionsResetZero')
      );
    } catch (error) {
      console.error('[Terminal] Failed to reset sessions', error);
      toast.error(t('failedToResetTerminals'));
    } finally {
      setIsKilling(false);
    }
  };

  return (
    <section
      className={cn(
        'flex h-full min-h-0 flex-col bg-background',
        standalone ? 'border-0' : 'border-t border-border',
        className
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 min-h-[44px]">
        <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground font-bold uppercase tracking-widest shrink-0">
          {t('title')}
        </div>
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5 max-w-full">
            <div className="flex items-center gap-1 min-w-max">
              {!standalone && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        window.dispatchEvent(
                          new CustomEvent('terminal-resize', { detail: { action: 'fullscreen' } })
                        );
                      }}
                      aria-label={isFullscreen ? t('exitFullscreen') : t('fullscreenTerminal')}
                    >
                      {isFullscreen ? (
                        <Minimize2 className="h-4 w-4" />
                      ) : (
                        <Maximize2 className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isFullscreen ? t('exitFullscreen') : t('fullscreenTerminal')}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={selectMode ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    onClick={() => {
                      if (!activeSessionId) return;
                      const next = !selectMode;
                      setSelectMode(next);
                      window.dispatchEvent(
                        new CustomEvent('terminal-select-mode', {
                          detail: { sessionId: activeSessionId, enabled: next },
                        })
                      );
                    }}
                    aria-label={t('toggleSelectionMode')}
                    disabled={!activeSessionId}
                  >
                    <TextSelect className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('selectTextTouch')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      if (!activeSessionId) return;
                      window.dispatchEvent(
                        new CustomEvent('terminal-copy', {
                          detail: { sessionId: activeSessionId },
                        })
                      );
                    }}
                    aria-label={t('copyTerminalText')}
                    disabled={!activeSessionId}
                  >
                    <Clipboard className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('copySelectionOrAll')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      if (!activeSessionId) return;
                      window.dispatchEvent(
                        new CustomEvent('terminal-paste', {
                          detail: { sessionId: activeSessionId },
                        })
                      );
                    }}
                    aria-label={t('pasteIntoTerminal')}
                    disabled={!activeSessionId}
                  >
                    <Clipboard className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('pasteIntoTerminal')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      if (!activeSessionId) return;
                      window.dispatchEvent(
                        new CustomEvent('terminal-signal', {
                          detail: { sessionId: activeSessionId, signal: 'INT' },
                        })
                      );
                    }}
                    aria-label={t('stopProcess')}
                    disabled={!activeSessionId}
                  >
                    <OctagonX className="h-4 w-4 text-destructive" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('stopRunningProcess')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      if (!activeSessionId) return;
                      window.dispatchEvent(
                        new CustomEvent('terminal-command', {
                          detail: {
                            sessionId: activeSessionId,
                            command: 'claude --dangerously-skip-permissions',
                          },
                        })
                      );
                    }}
                    aria-label={t('runClaude')}
                    disabled={!activeSessionId}
                  >
                    <Bot className="h-4 w-4 text-chart-2" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('runClaude')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      if (!activeSessionId) return;
                      window.dispatchEvent(
                        new CustomEvent('terminal-command', {
                          detail: {
                            sessionId: activeSessionId,
                            command: 'codex -s danger-full-access',
                          },
                        })
                      );
                    }}
                    aria-label={t('runCodex')}
                    disabled={!activeSessionId}
                  >
                    <Code className="h-4 w-4 text-primary" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('runCodex')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      if (!activeSessionId) return;
                      window.dispatchEvent(
                        new CustomEvent('terminal-command', {
                          detail: {
                            sessionId: activeSessionId,
                            command: 'gemini --yolo',
                          },
                        })
                      );
                    }}
                    aria-label={t('runGemini')}
                    disabled={!activeSessionId}
                  >
                    <Bot className="h-4 w-4 text-chart-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('runGemini')}</TooltipContent>
              </Tooltip>
              <div className="w-px h-4 bg-border mx-1" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleCreateSession}
                    aria-label={t('newTerminal')}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('newTerminal')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleKillAll}
                    aria-label={t('killAllTerminals')}
                    disabled={sessions.length === 0 || isKilling}
                  >
                    <Skull className="h-4 w-4 transition-colors hover:text-destructive" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('killAllTerminals')}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </TooltipProvider>
      </div>
      {sessions.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 overflow-x-auto no-scrollbar bg-muted/20">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              className={cn(
                'group flex min-w-max items-center gap-2 border px-2.5 py-1 transition-all',
                activeSessionId === session.id
                  ? 'bg-accent text-accent-foreground border-border shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/70 border-transparent'
              )}
            >
              <span className="text-xs font-medium">{session.title}</span>
              <span
                className="flex h-4 w-4 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  void closeSessionEverywhere(session.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                role="button"
                aria-label={t('closeTerminalLabel', { title: session.title })}
                title={t('closeTerminal')}
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4">
            <Button
              variant="outline"
              size="lg"
              onClick={handleCreateSession}
              className="h-14 px-8 text-base font-semibold"
            >
              <Plus className="h-5 w-5 mr-2" />
              {t('openNewTerminalWindow')}
            </Button>
          </div>
        ) : (
          <div className="h-full w-full">
            <XTerminal sessionId={activeSessionId ?? sessions[0].id} />
          </div>
        )}
      </div>
    </section>
  );
}
