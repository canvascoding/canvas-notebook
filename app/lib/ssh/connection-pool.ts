import { Client } from 'ssh2';
import { createPool, Pool } from 'generic-pool';
import { readFileSync } from 'fs';
import path from 'path';

export interface SSHConnection {
  client: Client;
  connected: boolean;
}

function loadEnvFallback() {
  if (process.env.SSH_HOST && process.env.SSH_USER && process.env.SSH_PORT) {
    return;
  }

  const envPath = path.resolve(process.cwd(), '.env.local');
  let content = '';

  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  });
}

loadEnvFallback();

const SSH_CONFIG = {
  host: process.env.SSH_HOST || 'ssh.canvas.holdings',
  port: parseInt(process.env.SSH_PORT || '22'),
  username: process.env.SSH_USER || 'canvas-notebook',
};
let didLogConfig = false;

// Try to use SSH key if available, otherwise use password
function getSSHCredentials() {
  const password = process.env.SSH_PASSWORD;

  if (process.env.SSH_KEY_PATH) {
    try {
      return {
        privateKey: readFileSync(process.env.SSH_KEY_PATH),
        ...(password ? { password } : {}),
      };
    } catch {
      // SSH key not readable, try password
      if (password) {
        return {
          password,
        };
      }
    }
  }

  if (password) {
    return {
      password,
    };
  }

  throw new Error('No SSH credentials configured. Please set SSH_KEY_PATH or SSH_PASSWORD in .env.local');
}

class SSHConnectionPool {
  private pool: Pool<SSHConnection>;

  constructor() {
    const factory = {
      create: async (): Promise<SSHConnection> => {
        return new Promise((resolve, reject) => {
          const client = new Client();
          const timeout = setTimeout(() => {
            client.end();
            reject(new Error('SSH connection timeout'));
          }, 30000); // 30 second timeout

          client
            .on('ready', () => {
              clearTimeout(timeout);
              console.log('[SSH Pool] New connection established');
              resolve({
                client,
                connected: true,
              });
            })
            .on('error', (err) => {
              clearTimeout(timeout);
              console.error('[SSH Pool] Connection error:', err);
              reject(err);
            })
            .connect({
              ...(didLogConfig
                ? {}
                : (console.log('[SSH Pool] Config', {
                    host: SSH_CONFIG.host,
                    port: SSH_CONFIG.port,
                    username: SSH_CONFIG.username,
                    usernameType: typeof SSH_CONFIG.username,
                  }),
                  (didLogConfig = true),
                  {})),
              ...SSH_CONFIG,
              ...getSSHCredentials(),
              readyTimeout: 30000,
            });
        });
      },

      destroy: async (connection: SSHConnection): Promise<void> => {
        return new Promise((resolve) => {
          connection.client.end();
          connection.connected = false;
          console.log('[SSH Pool] Connection destroyed');
          resolve();
        });
      },

      validate: async (connection: SSHConnection): Promise<boolean> => {
        // Check if connection is still alive
        const socket = (connection.client as unknown as { _sock?: { destroyed?: boolean } })._sock;
        return connection.connected && Boolean(socket) && socket?.destroyed !== true;
      },
    };

    const poolMin = parseInt(process.env.SSH_POOL_MIN || '0'); // Start with 0, create on demand
    const poolMax = parseInt(process.env.SSH_POOL_MAX || '5');
    const idleTimeout = parseInt(process.env.SSH_POOL_IDLE_TIMEOUT || '600000'); // 10 minutes

    this.pool = createPool(factory, {
      min: poolMin,
      max: poolMax,
      idleTimeoutMillis: idleTimeout,
      testOnBorrow: true,
      acquireTimeoutMillis: 30000,
    });

    console.log(`[SSH Pool] Initialized with min=${poolMin}, max=${poolMax}`);
  }

  async acquire(): Promise<SSHConnection> {
    try {
      const connection = await this.pool.acquire();
      console.log('[SSH Pool] Connection acquired');
      return connection;
    } catch (error) {
      console.error('[SSH Pool] Failed to acquire connection:', error);
      throw error;
    }
  }

  async release(connection: SSHConnection): Promise<void> {
    try {
      await this.pool.release(connection);
      console.log('[SSH Pool] Connection released');
    } catch (error) {
      console.error('[SSH Pool] Failed to release connection:', error);
      // Try to destroy the connection if release fails
      try {
        await this.pool.destroy(connection);
      } catch (destroyError) {
        console.error('[SSH Pool] Failed to destroy connection:', destroyError);
      }
    }
  }

  async drain(): Promise<void> {
    await this.pool.drain();
    await this.pool.clear();
    console.log('[SSH Pool] Drained and cleared');
  }

  getPoolStats() {
    return {
      size: this.pool.size,
      available: this.pool.available,
      pending: this.pool.pending,
      max: this.pool.max,
      min: this.pool.min,
    };
  }
}

// Singleton instance
let sshPoolInstance: SSHConnectionPool | null = null;

export function getSSHPool(): SSHConnectionPool {
  if (!sshPoolInstance) {
    sshPoolInstance = new SSHConnectionPool();
  }
  return sshPoolInstance;
}

export async function withSSHConnection<T>(
  fn: (connection: SSHConnection) => Promise<T>
): Promise<T> {
  const pool = getSSHPool();
  const connection = await pool.acquire();
  try {
    return await fn(connection);
  } finally {
    await pool.release(connection);
  }
}
