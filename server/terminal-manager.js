/* eslint-disable @typescript-eslint/no-require-imports */
const { Client } = require('ssh2');
const pty = require('node-pty');
const { existsSync } = require('fs');
const path = require('path');

const sessions = new Map();
const DEFAULT_IDLE_TIMEOUT = Number(process.env.TERMINAL_IDLE_TIMEOUT || 30 * 60 * 1000);
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS_PER_USER || 3);

const USE_LOCAL_TERMINAL = process.env.SSH_USE_LOCAL_FS === 'true';
const LOCAL_CWD = process.env.SSH_BASE_PATH 
  ? path.resolve(process.env.SSH_BASE_PATH) 
  : path.resolve(process.cwd(), 'workspace');

function getShellPath() {
  if (process.platform === 'darwin') return '/bin/zsh';
  return process.env.SHELL || '/bin/bash';
}

async function createSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  if (sessions.size >= MAX_TERMINALS) throw new Error('Terminal limit reached');

  const session = {
    id: sessionId,
    sshClient: null,
    stream: null,
    clients: new Set(),
    idleTimer: null,
    broadcast: (data) => {
      const payload = JSON.stringify({ type: 'output', data: data.toString() });
      session.clients.forEach(c => {
          if (c.readyState === 1) try { c.send(payload); } catch(e) {}
      });
    },
  };

  if (USE_LOCAL_TERMINAL) {
    const shell = getShellPath();
    const finalCwd = existsSync(LOCAL_CWD) ? LOCAL_CWD : process.cwd();
    
    console.log(`[Terminal] [${sessionId}] Starting ${shell} in ${finalCwd}`);
    
    try {
      // Wir übergeben eine saubere, aber funktionale Umgebung
      const env = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8'
      };

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
      
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[Terminal] [${sessionId}] Exit code: ${exitCode}`);
        sessions.delete(sessionId);
      });

      sessions.set(sessionId, session);
      return session;
    } catch (err) {
      console.error(`[Terminal] [${sessionId}] Spawn error:`, err.message);
      throw err;
    }
  }

  throw new Error('SSH mode not active');
}

function attachClient(session, ws) {
  session.clients.add(ws);
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.clients.size === 0) {
      session.idleTimer = setTimeout(() => {
        if (session.stream) try { session.stream.kill(); } catch(e) {}
        sessions.delete(session.id);
      }, DEFAULT_IDLE_TIMEOUT);
    }
  });
}

function handleMessage(session, message) {
  try {
    const payload = JSON.parse(message.toString());
    if (payload.type === 'input' && session.stream) session.stream.write(payload.data || '');
    if (payload.type === 'resize' && payload.data && session.stream) {
      const { cols, rows } = payload.data;
      try { session.stream.resize(cols, rows); } catch(e) {}
    }
  } catch (e) {}
}

module.exports = { createSession, attachClient, handleMessage };