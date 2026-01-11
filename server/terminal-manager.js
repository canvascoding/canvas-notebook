/* eslint-disable @typescript-eslint/no-require-imports */
const { Client } = require('ssh2');
const pty = require('node-pty');
const { readFileSync } = require('fs');

const sessions = new Map();

const DEFAULT_IDLE_TIMEOUT = Number(process.env.TERMINAL_IDLE_TIMEOUT || 30 * 60 * 1000);
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS_PER_USER || 3);

const SSH_CONFIG = {
  host: process.env.SSH_HOST || 'ssh.canvas.holdings',
  port: parseInt(process.env.SSH_PORT || '22'),
  username: process.env.SSH_USER || 'canvas-notebook',
};

const USE_LOCAL_TERMINAL = process.env.SSH_USE_LOCAL_FS === 'true';
const LOCAL_SHELL = process.env.SHELL || 'bash';
const LOCAL_CWD = process.env.SSH_BASE_PATH || process.env.HOME || '/';

function getSSHCredentials() {
  const password = process.env.SSH_PASSWORD;

  if (process.env.SSH_KEY_PATH) {
    try {
      return {
        privateKey: readFileSync(process.env.SSH_KEY_PATH),
        ...(password ? { password } : {}),
      };
    } catch {
      if (password) {
        return { password };
      }
    }
  }

  if (password) {
    return { password };
  }

  throw new Error('No SSH credentials configured');
}

function createSession(sessionId) {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  if (sessions.size >= MAX_TERMINALS) {
    throw new Error('Terminal limit reached');
  }

  if (USE_LOCAL_TERMINAL) {
    const session = {
      id: sessionId,
      sshClient: null,
      stream: null,
      clients: new Set(),
      idleTimer: null,
      broadcast: (data) => {
        const payload = JSON.stringify({ type: 'output', data: data.toString() });
        session.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(payload);
          }
        });
      },
    };

    sessions.set(sessionId, session);

    const ptyProcess = pty.spawn(LOCAL_SHELL, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: LOCAL_CWD,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
      },
    });

    session.stream = ptyProcess;

    ptyProcess.onData((data) => {
      session.broadcast(data);
    });

    ptyProcess.onExit(() => {
      console.log(`[Terminal] Local shell closed for session ${sessionId}`);
      sessions.delete(sessionId);
    });

    console.log(`[Terminal] Local shell opened for session ${sessionId}`);
    return Promise.resolve(session);
  }

  const sshClient = new Client();
  const cwd = process.env.SSH_BASE_PATH || '~';

  const session = {
    id: sessionId,
    sshClient,
    stream: null,
    clients: new Set(),
    idleTimer: null,
    broadcast: (data) => {
      const payload = JSON.stringify({ type: 'output', data: data.toString() });
      session.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(payload);
        }
      });
    },
  };

  sessions.set(sessionId, session);

  return new Promise((resolve, reject) => {
    sshClient
      .on('ready', () => {
        console.log(`[Terminal] SSH connection ready for session ${sessionId}`);

        // Open shell with proper environment
        sshClient.shell(
          {
            term: 'xterm-256color',
            cols: 80,
            rows: 24,
            env: {
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              LANG: 'en_US.UTF-8',
            },
          },
          (err, stream) => {
            if (err) {
              console.error(`[Terminal] Failed to open shell for session ${sessionId}:`, err);
              sshClient.end();
              sessions.delete(sessionId);
              reject(err);
              return;
            }

            session.stream = stream;

            // Change to working directory
            stream.write(`cd "${cwd}" 2>/dev/null || cd ~\n`);
            stream.write('clear\n');

            stream.on('data', (data) => {
              session.broadcast(data);
            });

            stream.on('close', () => {
              console.log(`[Terminal] Stream closed for session ${sessionId}`);
              sshClient.end();
              sessions.delete(sessionId);
            });

            stream.stderr.on('data', (data) => {
              session.broadcast(data);
            });

            console.log(`[Terminal] Shell opened for session ${sessionId}`);
            resolve(session);
          }
        );
      })
      .on('error', (err) => {
        console.error(`[Terminal] SSH connection error for session ${sessionId}:`, err);
        sessions.delete(sessionId);
        reject(err);
      })
      .on('close', () => {
        console.log(`[Terminal] SSH connection closed for session ${sessionId}`);
        sessions.delete(sessionId);
      })
      .connect({
        ...SSH_CONFIG,
        ...getSSHCredentials(),
        readyTimeout: 10000, // Reduced from 30s to 10s to prevent WebSocket timeouts
      });
  });
}

function attachClient(session, ws) {
  session.clients.add(ws);
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.clients.size === 0) {
      console.log(`[Terminal] Last client disconnected from session ${session.id}, will cleanup after idle timeout`);
      session.idleTimer = setTimeout(() => {
        console.log(`[Terminal] Cleaning up idle session ${session.id}`);
        try {
          if (session.stream) {
            if (typeof session.stream.close === 'function') {
              session.stream.close();
            } else if (typeof session.stream.kill === 'function') {
              session.stream.kill();
            } else if (typeof session.stream.end === 'function') {
              session.stream.end();
            }
          }
          if (session.sshClient) {
            session.sshClient.end();
          }
        } catch {
          // ignore
        }
        sessions.delete(session.id);
      }, DEFAULT_IDLE_TIMEOUT); // 30 minutes (default)
    }
  });
}

function handleMessage(session, message) {
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch {
    return;
  }

  if (payload.type === 'input' && session.stream) {
    session.stream.write(payload.data || '');
  }

  if (payload.type === 'resize' && payload.data && session.stream) {
    const { cols, rows } = payload.data;
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      if (typeof session.stream.setWindow === 'function') {
        session.stream.setWindow(rows, cols);
      } else if (typeof session.stream.resize === 'function') {
        session.stream.resize(cols, rows);
      }
    }
  }

  if (payload.type === 'signal' && session.stream) {
    const signal = typeof payload.data === 'string' ? payload.data : 'INT';
    if (typeof session.stream.signal === 'function') {
      session.stream.signal(signal);
    } else if (typeof session.stream.kill === 'function') {
      session.stream.kill(signal);
    } else if (signal === 'INT') {
      session.stream.write('\u0003');
    }
  }
}

function terminateAllSessions() {
  let closed = 0;
  sessions.forEach((session, sessionId) => {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    session.clients.forEach((client) => {
      try {
        if (typeof client.close === 'function') {
          client.close(1000, 'Terminals reset');
        }
      } catch {
        // ignore
      }
    });
    try {
      if (session.stream) {
        if (typeof session.stream.close === 'function') {
          session.stream.close();
        } else if (typeof session.stream.kill === 'function') {
          session.stream.kill();
        } else if (typeof session.stream.end === 'function') {
          session.stream.end();
        }
      }
    } catch {
      // ignore
    }
    try {
      if (session.sshClient) {
        session.sshClient.end();
      }
    } catch {
      // ignore
    }
    sessions.delete(sessionId);
    closed += 1;
  });
  return { closed };
}

module.exports = {
  createSession,
  attachClient,
  handleMessage,
  terminateAllSessions,
};
