'use client';

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';

interface XTerminalProps {
  sessionId: string;
}

export function XTerminal({ sessionId }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const isIntentionallyClosed = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create terminal with full configuration
    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      fontWeight: 500,
      fontWeightBold: 700,
      minimumContrastRatio: 7,
      theme: {
        background: '#1e1e1e',
        foreground: '#f5f5f5',
        cursor: '#ffffff',
        selectionBackground: 'rgba(255, 255, 255, 0.25)',
        selectionForeground: '#111111',
        selectionInactiveBackground: 'rgba(255, 255, 255, 0.18)',
        black: '#5c5c5c',
        red: '#cc0000',
        green: '#4e9a06',
        yellow: '#c4a000',
        blue: '#3465a4',
        magenta: '#75507b',
        cyan: '#06989a',
        white: '#d3d7cf',
        brightBlack: '#9da3a6',
        brightRed: '#ef2929',
        brightGreen: '#8ae234',
        brightYellow: '#fce94f',
        brightBlue: '#729fcf',
        brightMagenta: '#ad7fa8',
        brightCyan: '#34e2e2',
        brightWhite: '#eeeeec',
      },
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

    // iOS needs time to calculate dimensions
    setTimeout(() => {
      fitAddon.fit();
    }, 100);

    terminalRef.current = term;
    fitRef.current = fitAddon;

    // Custom key handler for Ctrl+C
    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        if (term.hasSelection()) {
          return true; // Allow copy
        }
        const currentSocket = socketRef.current;
        if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ type: 'input', data: '\u0003' }));
        }
        return false;
      }
      return true;
    });

    // Focus terminal immediately
    term.focus();

    // WebSocket connection with smart reconnect
    const connectWebSocket = (isReconnect = false) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/terminal/${sessionId}`;
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        console.log('[Terminal] Connected');
        reconnectAttempts.current = 0;
        if (isReconnect) {
          term.write('\r\n\x1b[32m[Reconnected]\x1b[0m\r\n');
        }
      });

      socket.addEventListener('close', (event) => {
        if (isIntentionallyClosed.current) return;

        console.log('[Terminal] Connection closed:', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean
        });

        // Server explicitly rejected (terminal limit, auth failure, etc)
        if (event.code === 1013 || event.code === 1008 || event.code === 1003 || event.code === 1000) {
          term.write(`\r\n\x1b[31m[Disconnected: ${event.reason || 'Unauthorized or Server closed'}]\x1b[0m\r\n`);
          return;
        }

        // Network issue or server restart - reconnect with backoff
        if (event.code === 1001 || event.code === 1006 || event.code === 1011) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
          reconnectAttempts.current++;

          // Show message only after 2nd attempt (reduces spam)
          if (reconnectAttempts.current > 1) {
            term.write(`\r\n\x1b[33m[Reconnecting...]\x1b[0m\r\n`);
          }

          reconnectTimeout.current = setTimeout(() => {
            if (!isIntentionallyClosed.current) {
              connectWebSocket(true);
            }
          }, delay);
        }
      });

      socket.addEventListener('error', (err) => {
        // Nur loggen, wenn der Socket nicht bereits im Begriff ist, sich zu öffnen oder offen ist.
        // Das reduziert das Rauschen durch Doppel-Mounts in Next.js Dev.
        if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) {
            console.warn('[Terminal] Transient WebSocket error');
        }
      });

      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'output') {
            term.write(payload.data);
          } else if (payload.type === 'ready') {
            console.log('[Terminal] Handshake complete, shell ready');
            term.write('\x1b[32m[Connected]\x1b[0m\r\n');
          }
        } catch {
          // ignore malformed payloads
        }
      });

      return socket;
    };

    connectWebSocket(false);

    // Handle custom terminal events
    const handleSignal = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: string; signal?: string } | undefined;
      if (!detail || detail.sessionId !== sessionId) return;
      const currentSocket = socketRef.current;
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        const signal = detail.signal || 'INT';
        if (signal === 'INT') {
          currentSocket.send(JSON.stringify({ type: 'input', data: '\u0003' }));
        } else {
          currentSocket.send(JSON.stringify({ type: 'signal', data: signal }));
        }
      }
    };

    const handleCommand = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: string; command?: string } | undefined;
      if (!detail || detail.sessionId !== sessionId || !detail.command) return;
      const currentSocket = socketRef.current;
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({ type: 'input', data: `${detail.command}\n` }));
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
      const currentSocket = socketRef.current;
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        try {
          const text = await navigator.clipboard.readText();
          currentSocket.send(JSON.stringify({ type: 'input', data: text }));
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
      const currentSocket = socketRef.current;
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle terminal resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dimensions = fitAddon.proposeDimensions();
      const currentSocket = socketRef.current;
      if (dimensions && currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(
          JSON.stringify({
            type: 'resize',
            data: { cols: dimensions.cols, rows: dimensions.rows },
          })
        );
      }
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
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Cleanup
    return () => {
      console.log('[Terminal] Cleanup for session', sessionId);
      isIntentionallyClosed.current = true;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
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
      if (socketRef.current) {
        socketRef.current.close();
      }
      term.dispose();
    };
  }, [sessionId]);

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
