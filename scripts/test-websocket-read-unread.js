#!/usr/bin/env node
/**
 * WebSocket Read/Unread Test
 * 
 * Tests session read/unread synchronization.
 * 
 * Usage:
 *   npm run test:websocket:read-unread
 */

const WebSocket = require('ws');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace('http:', 'ws:').replace('https:', 'wss:') + '/ws/chat';
const TEST_SESSION_ID = 'test-session-' + Date.now();

console.log('[WebSocket Read/Unread Test] Testing read/unread synchronization');

async function testReadUnread() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let authenticated = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Test timeout after 15s'));
    }, 15000);

    ws.on('open', () => {
      console.log('[WebSocket Read/Unread Test] ✓ Connected');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'auth_success') {
          authenticated = true;
          console.log('[WebSocket Read/Unread Test] ✓ Authenticated');
          
          // Subscribe to test session
          console.log('[WebSocket Read/Unread Test] Subscribing to session:', TEST_SESSION_ID);
          ws.send(JSON.stringify({ type: 'subscribe_session', sessionId: TEST_SESSION_ID }));
        }

        if (message.type === 'runtime_status') {
          console.log('[WebSocket Read/Unread Test] ✓ Received runtime status');
          
          // Test mark_read
          console.log('[WebSocket Read/Unread Test] Testing mark_read...');
          ws.send(JSON.stringify({ type: 'mark_read', sessionId: TEST_SESSION_ID }));
        }

        if (message.type === 'session_read') {
          console.log('[WebSocket Read/Unread Test] ✓ session_read event received');
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch (error) {
        console.error('[WebSocket Read/Unread Test] Error:', error);
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

testReadUnread()
  .then(() => {
    console.log('[WebSocket Read/Unread Test] ✓ All tests passed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[WebSocket Read/Unread Test] ✗ Test failed:', error.message);
    process.exit(1);
  });
