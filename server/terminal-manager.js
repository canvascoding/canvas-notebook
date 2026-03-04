/* eslint-disable @typescript-eslint/no-require-imports */
const pty = require('node-pty');
const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const sessions = new Map();
const DEFAULT_IDLE_TIMEOUT = Number(process.env.TERMINAL_IDLE_TIMEOUT || 30 * 60 * 1000);
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS_PER_USER || 3);

const LOCAL_CWD = process.env.WORKSPACE_DIR
  ? path.resolve(process.env.WORKSPACE_DIR)
  : path.resolve(process.cwd(), 'data', 'workspace');

function getShellPath() {
  if (process.platform === 'darwin') return '/bin/zsh';
  return process.env.SHELL || '/bin/bash';
}

async function createSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  if (sessions.size >= MAX_TERMINALS) throw new Error('Terminal limit reached');

  const session = {
    id: sessionId,
    stream: null,
    clients: new Set(),
    idleTimer: null,
    broadcast: (data) => {
      const payload = JSON.stringify({ type: 'output', data: data.toString() });
      session.clients.forEach(c => {
          if (c.readyState === 1) try { c.send(payload); } catch {}
      });
    },
  };

  const shell = getShellPath();
  const finalCwd = existsSync(LOCAL_CWD) ? LOCAL_CWD : process.cwd();

  console.log(`[Terminal] [${sessionId}] Starting ${shell} in ${finalCwd}`);

  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8'
  };

  try {
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: finalCwd,
      env: env
    });

    console.log(`[Terminal] [${sessionId}] PTY started (PID: ${ptyProcess.pid})`);

    session.stream = ptyProcess;
    ptyProcess.onData(data => session.broadcast(data));
    
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[Terminal] [${sessionId}] Exit code: ${exitCode}`);
      sessions.delete(sessionId);
    });

    sessions.set(sessionId, session);
    return session;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Terminal] [${sessionId}] PTY spawn failed (${message}). Falling back to child_process shell.`);
  }

  try {
    const child = spawn(shell, [], {
      cwd: finalCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => session.broadcast(data));
    child.stderr.on('data', (data) => session.broadcast(data));
    child.on('exit', (exitCode) => {
      console.log(`[Terminal] [${sessionId}] Child shell exit code: ${exitCode}`);
      sessions.delete(sessionId);
    });
    child.on('error', (error) => {
      console.error(`[Terminal] [${sessionId}] Child shell error:`, error.message);
    });

    session.stream = {
      echoInput: true,
      write: (data) => {
        if (!child.killed) {
          const normalizedInput = String(data || '').replace(/\r/g, '\n');
          child.stdin.write(normalizedInput);
        }
      },
      resize: () => {},
      kill: () => {
        if (!child.killed) {
          child.kill();
        }
      },
    };

    console.log(`[Terminal] [${sessionId}] Child shell started (PID: ${child.pid ?? 'n/a'})`);

    sessions.set(sessionId, session);
    return session;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Terminal] [${sessionId}] Child shell spawn error:`, message);
    throw err;
  }
}

function attachClient(session, ws) {
  session.clients.add(ws);
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.clients.size === 0) {
      session.idleTimer = setTimeout(() => {
        if (session.stream) try { session.stream.kill(); } catch {}
        sessions.delete(session.id);
      }, DEFAULT_IDLE_TIMEOUT);
    }
  });
}

function handleMessage(session, ws, message) {
  try {
    const payload = JSON.parse(message.toString());
    if (payload.type === 'ping') {
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
      }
      return;
    }
    if (payload.type === 'input' && session.stream) {
      const input = payload.data || '';
      session.stream.write(input);
      if (session.stream.echoInput && input) {
        session.broadcast(input);
      }
    }
    if (payload.type === 'resize' && payload.data && session.stream) {
      const { cols, rows } = payload.data;
      try { session.stream.resize(cols, rows); } catch {}
    }
  } catch {}
}

function terminateAllSessions() {
  let closed = 0;
  for (const [id, session] of sessions) {
    if (session.stream) {
      try { session.stream.kill(); } catch {}
    }
    session.clients.forEach(c => {
      try { c.close(); } catch {}
    });
    sessions.delete(id);
    closed++;
  }
  return { closed };
}

module.exports = { createSession, attachClient, handleMessage, terminateAllSessions };
