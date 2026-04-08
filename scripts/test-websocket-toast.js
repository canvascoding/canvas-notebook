#!/usr/bin/env node
/**
 * WebSocket Toast Notification Test
 * 
 * Tests toast notification broadcasting.
 * 
 * Usage:
 *   npm run test:websocket:toast
 */

const WebSocket = require('ws');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace('http:', 'ws:').replace('https:', 'wss:') + '/ws/chat';

console.log('[WebSocket Toast Test] Testing toast notification broadcasting');

async function testToast() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let authenticated = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Test timeout after 10s'));
    }, 10000);

    ws.on('open', () => {
      console.log('[WebSocket Toast Test] ✓ Connected');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'auth_success') {
          authenticated = true;
          console.log('[WebSocket Toast Test] ✓ Authenticated as user:', message.userId);
          
          // Subscribe to a session
          const sessionId = 'test-session-' + Date.now();
          console.log('[WebSocket Toast Test] Subscribing to session:', sessionId);
          ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
        }

        if (message.type === 'notification') {
          console.log('[WebSocket Toast Test] ✓ Notification received:', message);
          clearTimeout(timeout);
          ws.close();
          resolve();
        }

        if (message.type === 'runtime_status') {
          console.log('[WebSocket Toast Test] ✓ Runtime status received');
        }
      } catch (error) {
        console.error('[WebSocket Toast Test] Error:', error);
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

testToast()
  .then(() => {
    console.log('[WebSocket Toast Test] ✓ All tests passed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[WebSocket Toast Test] ✗ Test failed:', error.message);
    process.exit(1);
  });
