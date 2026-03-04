'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Bot,
  ChevronDown,
  ChevronUp,
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

// Dynamic import to prevent SSR issues with xterm.js
const XTerminal = dynamic(() => import('./XTerminal').then(mod => ({ default: mod.XTerminal })), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading terminal...
    </div>
  ),
});

export function TerminalPanel() {
  const {
    sessions,
    activeSessionId,
    hydrated,
    createSession,
    closeSession,
    clearSessions,
    setActiveSession,
  } = useTerminalStore();
  const [selectMode, setSelectMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isKilling, setIsKilling] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    if (sessions.length === 0) {
      createSession();
    }
  }, [hydrated, sessions.length, createSession]);

  useEffect(() => {
    if (!hydrated) return;
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSession(sessions[0].id);
    }
  }, [hydrated, sessions, activeSessionId, setActiveSession]);

  useEffect(() => {
    if (!hydrated) return;
    const MAX_SAVED_SESSIONS = 3;
    if (sessions.length > MAX_SAVED_SESSIONS) {
      sessions.slice(MAX_SAVED_SESSIONS).forEach((session) => {
        closeSession(session.id);
      });
    }
  }, [hydrated, sessions, closeSession]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      // Only intercept Ctrl+T if target is not in terminal
      const target = event.target as HTMLElement;
      const isInTerminal = target.closest('.xterm, .xterm-screen');

      if (!isInTerminal && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
        event.preventDefault();
        createSession();
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [createSession]);

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
    const confirmed = window.confirm('Kill all terminal sessions?');
    if (!confirmed) return;
    setIsKilling(true);
    try {
      const response = await fetch('/api/terminal/kill', { method: 'POST' });
      if (!response.ok) {
        throw new Error('Failed to reset terminals');
      }
      clearSessions();
      setSelectMode(false);
      toast.success('Terminal sessions reset');
    } catch (error) {
      console.error('[Terminal] Failed to reset sessions', error);
      toast.error('Failed to reset terminals');
    } finally {
      setIsKilling(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col border-t border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 min-h-[44px]">
        <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground font-bold uppercase tracking-widest shrink-0">
          Terminal
        </div>
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5 max-w-full">
            <div className="flex items-center gap-1 min-w-max">
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
                    aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen terminal'}
                  >
                    {isFullscreen ? (
                      <Minimize2 className="h-4 w-4" />
                    ) : (
                      <Maximize2 className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isFullscreen ? 'Exit fullscreen' : 'Fullscreen terminal'}
                </TooltipContent>
              </Tooltip>
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
                    aria-label="Toggle selection mode"
                    disabled={!activeSessionId}
                  >
                    <TextSelect className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Select text (touch)</TooltipContent>
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
                    aria-label="Copy terminal text"
                    disabled={!activeSessionId}
                  >
                    <Clipboard className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy selection (or all)</TooltipContent>
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
                    aria-label="Paste into terminal"
                    disabled={!activeSessionId}
                  >
                    <Clipboard className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Paste into terminal</TooltipContent>
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
                    aria-label="Stop process"
                    disabled={!activeSessionId}
                  >
                    <OctagonX className="h-4 w-4 text-red-500" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Stop running process</TooltipContent>
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
                    aria-label="Run Claude"
                    disabled={!activeSessionId}
                  >
                    <Bot className="h-4 w-4 text-emerald-400" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Run Claude</TooltipContent>
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
                    aria-label="Run Codex"
                    disabled={!activeSessionId}
                  >
                    <Code className="h-4 w-4 text-blue-400" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Run Codex</TooltipContent>
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
                    aria-label="Run Gemini"
                    disabled={!activeSessionId}
                  >
                    <Bot className="h-4 w-4 text-purple-400" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Run Gemini</TooltipContent>
              </Tooltip>
              <div className="w-px h-4 bg-border mx-1" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={createSession}
                    aria-label="New terminal"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New terminal</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleKillAll}
                    aria-label="Kill all terminals"
                    disabled={sessions.length === 0 || isKilling}
                  >
                    <Skull className="h-4 w-4 hover:text-red-500 transition-colors" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Kill all terminals</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </TooltipProvider>
      </div>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 overflow-x-auto no-scrollbar bg-muted/20">
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => setActiveSession(session.id)}
            className={cn(
              'group flex items-center gap-2 rounded-md px-2.5 py-1 transition-all min-w-max border',
              activeSessionId === session.id
                ? 'bg-accent text-accent-foreground border-border shadow-sm'
                : 'text-muted-foreground hover:bg-accent/70 border-transparent'
            )}
          >
            <span className="text-xs font-medium">{session.title}</span>
            <span
              className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              onClick={(event) => {
                event.stopPropagation();
                closeSession(session.id);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              role="button"
              aria-label={`Close ${session.title}`}
              title="Close terminal"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 relative">
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No active terminal
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
