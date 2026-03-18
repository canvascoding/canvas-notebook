/**
 * Terminal Service - Separater Prozess für Terminal-Management
 * 
 * Kommuniziert über Unix Socket (Docker) oder TCP (Local Dev)
 * Protokoll: JSON-RPC mit Message Framing
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'node-pty';
import { randomBytes } from 'crypto';

// Types
import type { IPty } from 'node-pty';

interface TerminalSession {
  id: string;
  ownerId: string;
  pty: IPty;
  clients: Set<net.Socket>;
  outputBuffer: string;
  idleTimer: NodeJS.Timeout | null;
  createdAt: Date;
  lastActivity: Date;
}

interface Message {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface Response {
  id: string;
  result?: Record<string, unknown> | string | number | boolean | null;
  error?: { code: number; message: string };
}

// Configuration
const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MAX_TERMINALS_PER_USER = 4;
const OUTPUT_BUFFER_LIMIT = 200_000;
const SOCKET_PATH = process.env.CANVAS_TERMINAL_SOCKET || '/tmp/canvas-terminal.sock';
const TCP_PORT = parseInt(process.env.CANVAS_TERMINAL_PORT || '3457', 10);
const AUTH_TOKEN = process.env.CANVAS_TERMINAL_TOKEN || generateToken();
const USE_UNIX_SOCKET = process.env.CANVAS_TERMINAL_USE_UNIX_SOCKET !== 'false';
const DATA = process.env.DATA || path.resolve(process.cwd(), 'data');
const WORKSPACE_DIR = path.join(DATA, 'workspace');

// State
const sessions = new Map<string, TerminalSession>();
const authenticatedClients = new Set<net.Socket>();

// Logging
const debug = process.env.TERMINAL_DEBUG === 'true';
function log(...args: unknown[]) {
  if (debug) {
    console.log('[Terminal Service]', ...args);
  }
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// Session Management
function normalizeOwnerId(ownerId: string): string {
  return ownerId?.trim() || 'anonymous';
}

function countOwnerSessions(ownerId: string): number {
  const normalized = normalizeOwnerId(ownerId);
  let count = 0;
  for (const session of sessions.values()) {
    if (session.ownerId === normalized) {
      count++;
    }
  }
  return count;
}

function clearIdleTimer(session: TerminalSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function scheduleIdleTermination(session: TerminalSession): void {
  clearIdleTimer(session);
  session.idleTimer = setTimeout(() => {
    log(`Session ${session.id} idle timeout`);
    terminateSession(session.id);
  }, DEFAULT_IDLE_TIMEOUT);
}

function evictIdleOwnerSessions(ownerId: string): void {
  const normalized = normalizeOwnerId(ownerId);
  const idleSessions: string[] = [];
  
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

function createSession(sessionId: string, ownerId: string, cwd: string): TerminalSession {
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
  const finalCwd = fs.existsSync(cwd) ? cwd : WORKSPACE_DIR;
  const shell = resolveShell();
  
  log(`Creating session ${sessionId} for ${normalizedOwnerId} in ${finalCwd}`);

  let ptyProcess: IPty;
  try {
    ptyProcess = spawn(shell, [], {
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown spawn error';
    throw new Error(`Failed to spawn terminal shell "${shell}" in "${finalCwd}": ${errorMessage}`);
  }
  
  const session: TerminalSession = {
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
  ptyProcess.onData((data: string) => {
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
  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
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
  scheduleIdleTermination(session);
  return session;
}

function resolveShell(): string {
  const candidates = [
    process.env.CANVAS_TERMINAL_SHELL,
    process.env.SHELL,
    '/bin/bash',
    '/bin/sh',
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '/bin/sh';
}

function attachClient(sessionId: string, client: net.Socket): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.clients.add(client);
  
  // Clear idle timer
  clearIdleTimer(session);
  
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

function detachClient(sessionId: string, client: net.Socket): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  session.clients.delete(client);
  
  // Start idle timer if no clients connected
  if (session.clients.size === 0) {
    scheduleIdleTermination(session);
  }
}

function terminateSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  log(`Terminating session ${sessionId}`);
  
  clearIdleTimer(session);
  
  try {
    session.pty.kill();
  } catch {
    // Ignore errors
  }
  
  sessions.delete(sessionId);
}

function terminateOwnerSessions(ownerId: string): number {
  const normalized = normalizeOwnerId(ownerId);
  const ownedSessionIds: string[] = [];

  for (const [id, session] of sessions.entries()) {
    if (session.ownerId === normalized) {
      ownedSessionIds.push(id);
    }
  }

  for (const sessionId of ownedSessionIds) {
    terminateSession(sessionId);
  }

  return ownedSessionIds.length;
}

function handleInput(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.pty.write(data);
  session.lastActivity = new Date();
}

function handleResize(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  session.pty.resize(cols, rows);
}

// Message Handling
function handleMessage(client: net.Socket, message: Message): void {
  const { id, method, params } = message;
  
  try {
    switch (method) {
      case 'auth': {
        const { token } = params as { token: string };
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

        const { sessionId, ownerId, cwd } = params as { sessionId: string; ownerId: string; cwd?: string };
        const session = createSession(sessionId, ownerId, cwd || WORKSPACE_DIR);
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

        const { sessionId } = params as { sessionId: string };
        attachClient(sessionId, client);
        sendResult(client, id, { success: true });
        break;
      }

      case 'input': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }

        const { sessionId, data } = params as { sessionId: string; data: string };
        handleInput(sessionId, data);
        sendResult(client, id, { success: true });
        break;
      }

      case 'resize': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }

        const { sessionId, cols, rows } = params as { sessionId: string; cols: number; rows: number };
        handleResize(sessionId, cols, rows);
        sendResult(client, id, { success: true });
        break;
      }

      case 'terminate': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }

        const { sessionId } = params as { sessionId: string };
        terminateSession(sessionId);
        sendResult(client, id, { success: true });
        break;
      }

      case 'terminateAll': {
        if (!authenticatedClients.has(client)) {
          sendError(client, id, 401, 'Unauthorized');
          return;
        }

        const { ownerId } = params as { ownerId: string };
        const closed = terminateOwnerSessions(ownerId);
        sendResult(client, id, { success: true, closed });
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
  } catch (error: unknown) {
    log('Error handling message:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal error';
    sendError(client, id, 500, errorMessage);
  }
}

function sendResult(client: net.Socket, id: string, result: Record<string, unknown> | string | number | boolean | null): void {
  if (client.destroyed) return;
  const response: Response = { id, result };
  client.write(JSON.stringify(response) + '\n');
}

function sendError(client: net.Socket, id: string, code: number, message: string): void {
  if (client.destroyed) return;
  const response: Response = { 
    id, 
    error: { code, message } 
  };
  client.write(JSON.stringify(response) + '\n');
}

// Server Setup
function startServer(): void {
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
          } catch {
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
