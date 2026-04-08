#!/usr/bin/env node
/**
 * WebSocket Connection Test
 * 
 * Tests basic WebSocket connection and authentication.
 * 
 * Usage:
 *   npm run test:websocket:connection
 */

const WebSocket = require('ws');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace('http:', 'ws:').replace('https:', 'wss:') + '/ws/chat';

console.log('[WebSocket Test] Testing connection to:', WS_URL);

async function testConnection() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let authenticated = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout after 10s'));
    }, 10000);

    ws.on('open', () => {
      console.log('[WebSocket Test] ✓ Connected');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log('[WebSocket Test] Received:', message.type);

        if (message.type === 'auth_success') {
          authenticated = true;
          console.log('[WebSocket Test] ✓ Authenticated as user:', message.userId);
          clearTimeout(timeout);
          ws.close();
          resolve();
        } else if (message.type === 'auth_error') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error('Authentication failed: ' + message.error));
        }
      } catch (error) {
        console.error('[WebSocket Test] Error parsing message:', error);
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    ws.on('close', () => {
      if (!authenticated) {
        reject(new Error('Connection closed before authentication'));
      }
    });
  });
}

testConnection()
  .then(() => {
    console.log('[WebSocket Test] ✓ All tests passed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[WebSocket Test] ✗ Test failed:', error.message);
    process.exit(1);
  });
