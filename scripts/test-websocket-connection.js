#!/usr/bin/env node
/**
 * WebSocket Connection Test
 *
 * Tests authenticated WebSocket connection plus a `send_message` regression check
 * so the socket path never falls back into an internal unauthenticated `HTTP 401`.
 *
 * Usage:
 *   npm run test:websocket:connection
 */

const path = require('path');
const WebSocket = require('ws');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace('http:', 'ws:').replace('https:', 'wss:') + '/ws/chat';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

console.log('[WebSocket Test] Testing connection to:', WS_URL);

async function authenticate() {
  const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE_URL,
    },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: HTTP ${response.status}`);
  }

  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length === 0) {
    throw new Error('Login succeeded but no auth cookies were returned');
  }

  return cookies.map((entry) => entry.split(';')[0]).join('; ');
}

async function createSession(cookieHeader) {
  const response = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: cookieHeader,
    },
    body: JSON.stringify({
      title: `websocket connection probe ${Date.now()}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Session creation failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const sessionId = payload?.session?.sessionId || payload?.sessionId;
  if (!sessionId) {
    throw new Error('Session creation succeeded but returned no sessionId');
  }

  return sessionId;
}

async function testConnection() {
  const cookieHeader = await authenticate();
  const sessionId = await createSession(cookieHeader);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: {
        cookie: cookieHeader,
        origin: BASE_URL,
      },
    });
    let authenticated = false;
    let regressionChecked = false;
    let settled = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout after 10s'));
    }, 10000);

    const settle = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    ws.on('open', () => {
      console.log('[WebSocket Test] Connected');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log('[WebSocket Test] Received:', message.type);

        if (message.type === 'auth_success') {
          authenticated = true;
          console.log('[WebSocket Test] Authenticated as user:', message.userId);
          ws.send(JSON.stringify({
            type: 'send_message',
            sessionId,
            message: {
              role: 'user',
              content: 'Reply briefly so the websocket regression test can confirm prompt dispatch.',
              timestamp: Date.now(),
            },
            userTimeZone: 'Europe/Berlin',
            currentTime: new Date().toISOString(),
          }));

          setTimeout(() => {
            if (!regressionChecked) {
              regressionChecked = true;
              settle(() => {
                ws.close();
                console.log('[WebSocket Test] No HTTP 401 after send_message');
                resolve();
              });
            }
          }, 3000);
        } else if (message.type === 'auth_error') {
          settle(() => {
            ws.close();
            reject(new Error('Authentication failed: ' + message.error));
          });
        } else if (message.type === 'error') {
          settle(() => {
            ws.close();
            reject(new Error(`Server error after send_message: ${message.error}${message.code ? ` (${message.code})` : ''}`));
          });
        } else if (message.type === 'agent_event' && !regressionChecked) {
          regressionChecked = true;
          settle(() => {
            ws.close();
            console.log('[WebSocket Test] Received agent event after send_message');
            resolve();
          });
        }
      } catch (error) {
        console.error('[WebSocket Test] Error parsing message:', error);
      }
    });

    ws.on('error', (error) => {
      settle(() => reject(error));
    });

    ws.on('close', () => {
      if (!settled && !authenticated) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Connection closed before authentication'));
      }
    });
  });
}

testConnection()
  .then(() => {
    console.log('[WebSocket Test] All tests passed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[WebSocket Test] Test failed:', error.message);
    process.exit(1);
  });
