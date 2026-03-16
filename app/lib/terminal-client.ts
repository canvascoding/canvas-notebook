/**
 * Terminal Client - Verbindet Next.js mit Terminal Service
 * 
 * Unterstützt Unix Socket (Docker) und TCP (Local Dev)
 */

import * as net from 'net';
import * as fs from 'fs';
import { randomBytes } from 'crypto';

// Configuration
const SOCKET_PATH = process.env.CANVAS_TERMINAL_SOCKET || '/tmp/canvas-terminal.sock';
const TCP_PORT = parseInt(process.env.CANVAS_TERMINAL_PORT || '3457', 10);
const AUTH_TOKEN = process.env.CANVAS_TERMINAL_TOKEN || '';
const USE_UNIX_SOCKET = fs.existsSync(SOCKET_PATH);

interface TerminalMessage {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface TerminalResponse {
  id: string;
  result?: Record<string, unknown> | string | number | boolean | null;
  error?: { code: number; message: string };
}

class TerminalClient {
  private socket: net.Socket | null = null;
  private messageQueue: Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }> = new Map();
  private buffer = '';
  private authenticated = false;
  private messageId = 0;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        resolve();
        return;
      }

      this.socket = new net.Socket();
      
      this.socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      this.socket.on('error', (err) => {
        console.error('[Terminal Client] Socket error:', err.message);
        reject(err);
      });

      this.socket.on('close', () => {
        this.socket = null;
        this.authenticated = false;
      });

      if (USE_UNIX_SOCKET) {
        this.socket.connect(SOCKET_PATH, () => {
          this.authenticate().then(() => resolve()).catch(reject);
        });
      } else {
        this.socket.connect(TCP_PORT, '127.0.0.1', () => {
          this.authenticate().then(() => resolve()).catch(reject);
        });
      }
    });
  }

  private async authenticate(): Promise<void> {
    const response = await this.sendMessage('auth', { token: AUTH_TOKEN }) as { error?: { message: string } };
    if (response.error) {
      throw new Error(response.error.message);
    }
    this.authenticated = true;
  }

  private handleData(data: string): void {
    this.buffer += data;
    
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      
      if (line.trim()) {
        try {
          const message: TerminalResponse = JSON.parse(line);
          const pending = this.messageQueue.get(message.id);
          if (pending) {
            this.messageQueue.delete(message.id);
            if (message.error) {
              pending.reject(new Error(message.error.message));
            } else {
              pending.resolve(message.result);
            }
          }
        } catch {
          console.error('[Terminal Client] Invalid JSON:', line);
        }
      }
    }
  }

  private sendMessage(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected'));
        return;
      }

      const id = `${Date.now()}-${this.messageId++}`;
      const message: TerminalMessage = { id, method, params };

      this.messageQueue.set(id, { resolve, reject });

      this.socket.write(JSON.stringify(message) + '\n', (err) => {
        if (err) {
          this.messageQueue.delete(id);
          reject(err);
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.messageQueue.has(id)) {
          this.messageQueue.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 10000);
    });
  }

  async createSession(sessionId: string, ownerId: string, cwd?: string): Promise<unknown> {
    await this.connect();
    return this.sendMessage('create', { sessionId, ownerId, cwd });
  }

  async attachSession(sessionId: string): Promise<unknown> {
    await this.connect();
    return this.sendMessage('attach', { sessionId });
  }

  async sendInput(sessionId: string, data: string): Promise<unknown> {
    await this.connect();
    return this.sendMessage('input', { sessionId, data });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<unknown> {
    await this.connect();
    return this.sendMessage('resize', { sessionId, cols, rows });
  }

  async terminate(sessionId: string): Promise<unknown> {
    await this.connect();
    return this.sendMessage('terminate', { sessionId });
  }

  getSocket(): net.Socket | null {
    return this.socket;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.authenticated;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.authenticated = false;
  }
}

// Singleton instance
let client: TerminalClient | null = null;

export function getTerminalClient(): TerminalClient {
  if (!client) {
    client = new TerminalClient();
  }
  return client;
}

export function resetTerminalClient(): void {
  if (client) {
    client.disconnect();
    client = null;
  }
}

// Generate token for new sessions
export function generateSessionToken(): string {
  return randomBytes(16).toString('hex');
}
