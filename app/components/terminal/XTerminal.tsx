'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { useTheme } from 'next-themes';

interface XTerminalProps {
  sessionId: string;
}

function getTerminalTheme(isDark: boolean) {
  if (isDark) {
    return {
      background: '#0f151d',
      foreground: '#d9e5f0',
      cursor: '#d9e5f0',
      selectionBackground: 'rgba(124, 180, 230, 0.32)',
      selectionForeground: '#eaf2f9',
      selectionInactiveBackground: 'rgba(124, 180, 230, 0.2)',
      black: '#2d3a49',
      red: '#cf5f63',
      green: '#74a57f',
      yellow: '#c0a256',
      blue: '#7cb4e6',
      magenta: '#9f8bad',
      cyan: '#6bb0bf',
      white: '#d9e5f0',
      brightBlack: '#6d7e91',
      brightRed: '#e18488',
      brightGreen: '#8dcf9a',
      brightYellow: '#d8be78',
      brightBlue: '#9bccf4',
      brightMagenta: '#bda9cb',
      brightCyan: '#89cad8',
      brightWhite: '#f3f8fc',
    };
  }

  return {
    background: '#f4f7fa',
    foreground: '#1a2735',
    cursor: '#1a2735',
    selectionBackground: 'rgba(56, 108, 158, 0.22)',
    selectionForeground: '#0f1b28',
    selectionInactiveBackground: 'rgba(56, 108, 158, 0.14)',
    black: '#324354',
    red: '#b44c52',
    green: '#2f7a49',
    yellow: '#8a6d24',
    blue: '#2a5f99',
    magenta: '#705685',
    cyan: '#2d7383',
    white: '#dfe8f0',
    brightBlack: '#5e7287',
    brightRed: '#d05f67',
    brightGreen: '#459863',
    brightYellow: '#a7893c',
    brightBlue: '#3f78b8',
    brightMagenta: '#8969a4',
    brightCyan: '#3d8ea3',
    brightWhite: '#ffffff',
  };
}

export function XTerminal({ sessionId }: XTerminalProps) {
  const t = useTranslations('terminal');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepAliveInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isIntentionallyClosed = useRef(false);
  const isReady = useRef(false);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== 'light';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initialIsDark = document.documentElement.classList.contains('dark');

    // Create terminal with full configuration
    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      fontWeight: 500,
      fontWeightBold: 700,
      minimumContrastRatio: 7,
      theme: getTerminalTheme(initialIsDark),
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: false,
      disableStdin: false,
    });

    // Load all addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const clipboardAddon = new ClipboardAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(clipboardAddon);

    term.open(container);

    terminalRef.current = term;
    fitRef.current = fitAddon;

    // Custom key handler for Ctrl+C
    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        if (term.hasSelection()) {
          return true; // Allow copy
        }
        if (isReady.current) {
          sendInput('\u0003');
        }
        return false;
      }
      return true;
    });

    // Focus terminal immediately
    term.focus();

    const scheduledResizeTimers: ReturnType<typeof setTimeout>[] = [];

    // Send input via API
    const sendInput = async (data: string) => {
      try {
        await fetch(`/api/terminal/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });
      } catch (err) {
        console.error('[Terminal] Failed to send input:', err);
      }
    };

    // Send resize via API
    const sendResize = async () => {
      const host = containerRef.current;
      if (!host || host.clientWidth < 40 || host.clientHeight < 24) return;

      try {
        fitAddon.fit();
      } catch {
        return;
      }

      const cols = term.cols;
      const rows = term.rows;
      if (cols < 2 || rows < 1) return;

      if (isReady.current) {
        try {
          await fetch(`/api/terminal/${sessionId}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cols, rows }),
          });
        } catch (err) {
          console.error('[Terminal] Failed to send resize:', err);
        }
      }
    };

    const scheduleResizeSync = (delays: number[]) => {
      delays.forEach((delay) => {
        const timer = setTimeout(() => {
          if (!isIntentionallyClosed.current) {
            sendResize();
          }
        }, delay);
        scheduledResizeTimers.push(timer);
      });
    };

    // Create session and connect SSE
    const connectTerminal = async () => {
      try {
        // First, create the session
        const createResponse = await fetch('/api/terminal/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });

        if (!createResponse.ok) {
          const error = await createResponse.json();
          throw new Error(error.error || t('failedToCreateSession'));
        }

        // Then connect to SSE stream
        const eventSource = new EventSource(`/api/terminal/${sessionId}/stream`);
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          reconnectAttempts.current = 0;
          if (reconnectTimeout.current) {
            clearTimeout(reconnectTimeout.current);
            reconnectTimeout.current = null;
          }
        };

        eventSource.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            
            if (payload.type === 'output') {
              term.write(payload.data);
            } else if (payload.type === 'ready') {
              isReady.current = true;
              scheduleResizeSync([0, 80, 220, 500]);
            } else if (payload.type === 'exit') {
              term.write(`\r\n\x1b[31m[${t('processExitedWithCode', { code: payload.exitCode })}]\x1b[0m\r\n`);
              isReady.current = false;
            } else if (payload.type === 'error') {
              term.write(`\r\n\x1b[31m[${t('terminalError', { error: payload.error })}]\x1b[0m\r\n`);
            }
          } catch {
            // ignore malformed payloads
          }
        };

        eventSource.onerror = () => {
          if (isIntentionallyClosed.current) return;
          
          // Connection error - try to reconnect
          eventSource.close();
          isReady.current = false;
          
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000);
          reconnectAttempts.current++;

          reconnectTimeout.current = setTimeout(() => {
            if (!isIntentionallyClosed.current) {
              connectTerminal();
            }
          }, delay);
        };

        // Keep-alive ping
        if (keepAliveInterval.current) {
          clearInterval(keepAliveInterval.current);
        }
        keepAliveInterval.current = setInterval(() => {
          if (eventSource.readyState === EventSource.OPEN) {
            // SSE doesn't need explicit ping, but we can check connection
          }
        }, 15000);

      } catch (err: unknown) {
        console.error('[Terminal] Connection error:', err);
        const errorMessage = err instanceof Error ? err.message : t('failedToCreateSession');
        term.write(`\r\n\x1b[31m[${t('connectionFailed', { error: errorMessage })}]\x1b[0m\r\n`);
        
        // Retry with backoff
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000);
        reconnectAttempts.current++;
        
        reconnectTimeout.current = setTimeout(() => {
          if (!isIntentionallyClosed.current) {
            connectTerminal();
          }
        }, delay);
      }
    };

    // Start connection
    connectTerminal();
    scheduleResizeSync([0, 100, 300, 700]);
    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => scheduleResizeSync([0, 120]))
        .catch(() => {});
    }

    // Handle custom terminal events
    const handleSignal = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: string; signal?: string } | undefined;
      if (!detail || detail.sessionId !== sessionId) return;
      if (isReady.current) {
        const signal = detail.signal || 'INT';
        if (signal === 'INT') {
          sendInput('\u0003');
        }
      }
    };

    const handleCommand = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: string; command?: string } | undefined;
      if (!detail || detail.sessionId !== sessionId || !detail.command) return;
      if (isReady.current) {
        sendInput(`${detail.command}\n`);
      }
    };

    const handleCopy = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: string } | undefined;
      if (!detail || detail.sessionId !== sessionId) return;
      const selected = term.getSelection();
      let autoSelected = false;
      let textToCopy = selected;

      if (!textToCopy) {
        term.selectAll();
        autoSelected = true;
        textToCopy = term.getSelection();
      }

      if (textToCopy) {
        navigator.clipboard?.writeText(textToCopy).catch(() => {});
      }

      if (autoSelected) {
        term.clearSelection();
      }
    };

    const handlePaste = async (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: string } | undefined;
      if (!detail || detail.sessionId !== sessionId) return;
      if (isReady.current) {
        try {
          const text = await navigator.clipboard.readText();
          sendInput(text);
        } catch (err) {
          console.error('[Terminal] Failed to paste from clipboard:', err);
        }
      }
    };

    const handleSelectMode = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: string; enabled?: boolean } | undefined;
      if (!detail || detail.sessionId !== sessionId) return;
      selectionMode = Boolean(detail.enabled);
      container.style.touchAction = selectionMode ? 'none' : 'auto';
      if (!selectionMode) {
        term.clearSelection();
      }
    };

    // Touch selection helpers
    const getTouchRow = (clientY: number) => {
      const rect = container.getBoundingClientRect();
      const core = term as unknown as {
        _core?: { _renderService?: { dimensions?: { actualCellHeight?: number } } };
      };
      const cellHeight = core._core?._renderService?.dimensions?.actualCellHeight;
      if (!cellHeight || cellHeight <= 0) return null;
      const viewportRow = Math.floor((clientY - rect.top) / cellHeight);
      const clampedRow = Math.max(0, Math.min(term.rows - 1, viewportRow));
      return term.buffer.active.viewportY + clampedRow;
    };

    let selectionMode = false;
    let selecting = false;
    let selectionStartRow = 0;

    const handlePointerDown = (event: PointerEvent) => {
      // Always focus terminal first
      term.focus();

      if (!selectionMode || event.pointerType !== 'touch') return;
      const row = getTouchRow(event.clientY);
      if (row === null) return;
      selecting = true;
      selectionStartRow = row;
      term.selectLines(row, row);
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!selectionMode || !selecting || event.pointerType !== 'touch') return;
      const row = getTouchRow(event.clientY);
      if (row === null) return;
      const start = Math.min(selectionStartRow, row);
      const end = Math.max(selectionStartRow, row);
      term.selectLines(start, end);
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!selectionMode || event.pointerType !== 'touch') return;
      selecting = false;
    };

    // Handle terminal input
    term.onData((data) => {
      if (isReady.current) {
        sendInput(data);
      }
    });

    // Handle terminal resize
    const resizeObserver = new ResizeObserver(() => {
      sendResize();
    });

    resizeObserver.observe(container);

    // Handle focus events
    const handleFocus = () => {
      term.focus();
    };

    container.addEventListener('click', handleFocus);
    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerup', handlePointerUp);
    container.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('terminal-signal', handleSignal as EventListener);
    window.addEventListener('terminal-command', handleCommand as EventListener);
    window.addEventListener('terminal-copy', handleCopy as EventListener);
    window.addEventListener('terminal-paste', handlePaste as EventListener);
    window.addEventListener('terminal-select-mode', handleSelectMode as EventListener);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        term.focus();
        scheduleResizeSync([0, 120]);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Cleanup
    return () => {
      console.log('[Terminal] Cleanup for session', sessionId);
      isIntentionallyClosed.current = true;
      isReady.current = false;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (keepAliveInterval.current) {
        clearInterval(keepAliveInterval.current);
      }
      scheduledResizeTimers.forEach((timer) => clearTimeout(timer));
      resizeObserver.disconnect();
      container.removeEventListener('click', handleFocus);
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerup', handlePointerUp);
      container.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('terminal-signal', handleSignal as EventListener);
      window.removeEventListener('terminal-command', handleCommand as EventListener);
      window.removeEventListener('terminal-copy', handleCopy as EventListener);
      window.removeEventListener('terminal-paste', handlePaste as EventListener);
      window.removeEventListener('terminal-select-mode', handleSelectMode as EventListener);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      term.dispose();
    };
  }, [sessionId, t]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = getTerminalTheme(isDark);
  }, [isDark]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full min-h-0 overflow-hidden"
      style={{
        position: 'relative'
      }}
      tabIndex={0}
    />
  );
}
