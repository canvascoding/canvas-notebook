/**
 * Terminal Service - Separater Prozess für Terminal-Management
 * 
 * Kommuniziert über Unix Socket (Docker) oder TCP (Local Dev)
 * Protokoll: JSON-RPC mit Message Framing
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('node-pty');
const { randomBytes } = require('crypto');

// Configuration
const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MAX_TERMINALS_PER_USER = 4;
const OUTPUT_BUFFER_LIMIT = 200_000;
const SOCKET_PATH = process.env.CANVAS_TERMINAL_SOCKET || '/tmp/canvas-terminal.sock';
const TCP_PORT = parseInt(process.env.CANVAS_TERMINAL_PORT || '3457', 10);
const AUTH_TOKEN = process.env.CANVAS_TERMINAL_TOKEN || generateToken();
const USE_UNIX_SOCKET = process.env.CANVAS_TERMINAL_USE_UNIX_SOCKET !== 'false';
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.resolve(process.cwd(), 'data', 'workspace');

// State
const sessions = new Map();
const authenticatedClients = new Set();

// Logging
const debug = process.env.TERMINAL_DEBUG === 'true';
function log(...args) {
  if (debug) {
    console.log('[Terminal Service]', ...args);
  }
}

function generateToken() {
  return randomBytes(32).toString('hex');
}

// Session Management
function normalizeOwnerId(ownerId) {
  return ownerId?.trim() || 'anonymous';
}

function countOwnerSessions(ownerId) {
  const normalized = normalizeOwnerId(ownerId);
  let count = 0;
  for (const session of sessions.values()) {
    if (session.ownerId === normalized) {
      count++;
    }
  }
  return count;
}

function evictIdleOwnerSessions(ownerId) {
  const normalized = normalizeOwnerId(ownerId);
  const idleSessions = [];
  
  for (const [id, session] of sessions.entries()) {
    if (session.ownerId === normalized && session.clients.size === 0) {
      idleSessions.push(id);
    }
  }
  
  for (const id of idleSessions) {
    terminateSession(id);
    if (countOwnerSessions(ownerId) < MAX_TERMINALS_PER_USER) {
      break;
    }
  }
}

function createSession(sessionId, ownerId, cwd) {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  
  // Check if session already exists
  const existingSession = sessions.get(sessionId);
  if (existingSession) {
    if (existingSession.ownerId !== normalizedOwnerId) {
      throw new Error('Session ownership mismatch');
    }
    return existingSession;
  }
  
  // Check terminal limit
  if (countOwnerSessions(normalizedOwnerId) >= MAX_TERMINALS_PER_USER) {
    evictIdleOwnerSessions(normalizedOwnerId);
  }
  
  if (countOwnerSessions(normalizedOwnerId) >= MAX_TERMINALS_PER_USER) {
    throw new Error('Terminal limit reached');
  }
  
  // Create PTY
  const shell = process.env.SHELL || '/bin/bash';
  const finalCwd = fs.existsSync(cwd) ? cwd : WORKSPACE_DIR;
  
  log(`Creating session ${sessionId} for ${normalizedOwnerId} in ${finalCwd}`);
  
  const ptyProcess = spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: finalCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
    },
  });
  
  const session = {
    id: sessionId,
    ownerId: normalizedOwnerId,
    pty: ptyProcess,
    clients: new Set(),
    outputBuffer: '',
    idleTimer: null,
    createdAt: new Date(),
    lastActivity: new Date(),
  };
  
  // Handle PTY output
  ptyProcess.onData((data) => {
    session.outputBuffer += data;
    if (session.outputBuffer.length > OUTPUT_BUFFER_LIMIT) {
      session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_LIMIT);
    }
    
    // Broadcast to all connected clients
    const message = JSON.stringify({
      type: 'output',
      sessionId: session.id,
      data,
    });
    
    session.clients.forEach(client => {
      if (!client.destroyed) {
        client.write(message + '\n');
      }
    });
    
    session.lastActivity = new Date();
  });
  
  // Handle PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    log(`Session ${sessionId} exited with code ${exitCode}`);
    
    // Notify clients
    const message = JSON.stringify({
      type: 'exit',
      sessionId: session.id,
      exitCode,
    });
    
    session.clients.forEach(client => {
      if (!client.destroyed) {
        client.write(message + '\n');
      }
    });
    
    sessions.delete(sessionId);
  });
  
  sessions.set(sessionId, session);
  return session;
}

function attachClient(sessionId, client) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.clients.add(client);
  
  // Clear idle timer
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  
  // Send buffered output to new client
  if (session.outputBuffer) {
    const message = JSON.stringify({
      type: 'output',
      sessionId: session.id,
      data: session.outputBuffer,
    });
    client.write(message + '\n');
  }
  
  // Send ready message
  const readyMessage = JSON.stringify({
    type: 'ready',
    sessionId: session.id,
  });
  client.write(readyMessage + '\n');
  
  log(`Client attached to session ${sessionId}`);
}

function detachClient(sessionId, client) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  session.clients.delete(client);
  
  // Start idle timer if no clients connected
  if (session.clients.size === 0) {
    session.idleTimer = setTimeout(() => {
      log(`Session ${sessionId} idle timeout`);
      terminateSession(sessionId);
    }, DEFAULT_IDLE_TIMEOUT);
  }
}

function terminateSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  log(`Terminating session ${sessionId}`);
  
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  
  try {
    session.pty.kill();
  } catch (e) {
    // Ignore errors
  }
  
  sessions.delete(sessionId);
}

function handleInput(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.pty.write(data);
  session.lastActivity = new Date();
}

function handleResize(sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.pty.resize(cols, rows);
}

// Message Handling
function handleMessage(client, message) {
  const { id, method, params } = message;
  
  try {
    switch (method) {
      case 'auth': {
        const { token } = params;
        if (token !== AUTH_TOKEN) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }
        authenticatedClients.add(client);
        sendResult(client, id, { success: true });
        log('Client authenticated');
        break;
      }
      
      case 'create': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }
        
        const { sessionId, ownerId, cwd } = params;
        const session = createSession(sessionId, ownerId, cwd || WORKSPACE_DIR);
        attachClient(sessionId, client);
        sendResult(client, id, { 
          success: true, 
          sessionId: session.id,
          pid: session.pty.pid,
        });
        break;
      }
      
      case 'attach': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }
        
        const { sessionId } = params;
        attachClient(sessionId, client);
        sendResult(client, id, { success: true });
        break;
      }
      
      case 'input': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }
        
        const { sessionId, data } = params;
        handleInput(sessionId, data);
        sendResult(client, id, { success: true });
        break;
      }
      
      case 'resize': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }
        
        const { sessionId, cols, rows } = params;
        handleResize(sessionId, cols, rows);
        sendResult(client, id, { success: true });
        break;
      }
      
      case 'terminate': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }
        
        const { sessionId } = params;
        terminateSession(sessionId);
        sendResult(client, id, { success: true });
        break;
      }
      
      case 'ping': {
        sendResult(client, id, { type: 'pong' });
        break;
      }
      
      default: {
        sendError(client, id, 404, `Unknown method: ${method}`);
      }
    }
  } catch (error) {
    log('Error handling message:', error);
    sendError(client, id, 500, error.message || 'Internal error');
  }
}

function sendResult(client, id, result) {
  if (client.destroyed) return;
  const response = { id, result };
  client.write(JSON.stringify(response) + '\n');
}

function sendError(client, id, code, message) {
  if (client.destroyed) return;
  const response = { 
    id, 
    error: { code, message } 
  };
  client.write(JSON.stringify(response) + '\n');
}

// Server Setup
function startServer() {
  const server = net.createServer((socket) => {
    log('Client connected');
    
    let buffer = '';
    
    socket.on('data', (data) => {
      buffer += data.toString();
      
      // Process complete messages (newline-delimited JSON)
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            handleMessage(socket, message);
          } catch (e) {
            log('Invalid JSON:', line);
          }
        }
      }
    });
    
    socket.on('close', () => {
      log('Client disconnected');
      authenticatedClients.delete(socket);
      
      // Detach from all sessions
      for (const [sessionId, session] of sessions.entries()) {
        if (session.clients.has(socket)) {
          detachClient(sessionId, socket);
        }
      }
    });
    
    socket.on('error', (err) => {
      log('Socket error:', err.message);
    });
  });
  
  if (USE_UNIX_SOCKET) {
    // Unix Socket mode (Docker)
    // Remove existing socket file
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
    
    server.listen(SOCKET_PATH, () => {
      log(`Terminal service listening on Unix Socket: ${SOCKET_PATH}`);
      // Set permissions so Next.js process can connect
      fs.chmodSync(SOCKET_PATH, 0o666);
    });
  } else {
    // TCP mode (Local dev)
    server.listen(TCP_PORT, '127.0.0.1', () => {
      log(`Terminal service listening on TCP: 127.0.0.1:${TCP_PORT}`);
    });
  }
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down...');
    
    // Terminate all sessions
    for (const sessionId of sessions.keys()) {
      terminateSession(sessionId);
    }
    
    server.close(() => {
      // Remove socket file
      if (USE_UNIX_SOCKET && fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
      process.exit(0);
    });
  });
  
  process.on('SIGINT', () => {
    log('SIGINT received, shutting down...');
    
    // Terminate all sessions
    for (const sessionId of sessions.keys()) {
      terminateSession(sessionId);
    }
    
    server.close(() => {
      // Remove socket file
      if (USE_UNIX_SOCKET && fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
      process.exit(0);
    });
  });
}

// Start
log('Starting Terminal Service...');
log(`Auth token: ${AUTH_TOKEN.substring(0, 8)}...`);
startServer();
