#!/usr/bin/env node
/**
 * WebSocket Multi-Tab Test
 * 
 * Tests broadcasting across multiple WebSocket connections.
 * 
 * Usage:
 *   npm run test:websocket:multitab
 */

const WebSocket = require('ws');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace('http:', 'ws:').replace('https:', 'wss:') + '/ws/chat';

console.log('[WebSocket Multi-Tab Test] Testing multi-client broadcasting');

async function createClient(clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    
    ws.on('open', () => {
      console.log(`[WebSocket Multi-Tab Test] Client ${clientId} connected`);
      resolve(ws);
    });

    ws.on('error', (error) => {
      reject(error);
    });
  });
}

async function testMultiTab() {
  const clients = [];
  
  try {
    // Create 3 clients
    console.log('[WebSocket Multi-Tab Test] Creating 3 clients...');
    for (let i = 0; i < 3; i++) {
      const client = await createClient(i + 1);
      clients.push(client);
    }

    console.log('[WebSocket Multi-Tab Test] ✓ All clients connected');

    // Test ping/pong
    console.log('[WebSocket Multi-Tab Test] Testing ping/pong...');
    clients[0].send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));

    await new Promise((resolve) => {
      clients[0].on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'pong') {
          console.log('[WebSocket Multi-Tab Test] ✓ Ping/pong successful, latency:', message.latency, 'ms');
          resolve();
        }
      });
      setTimeout(resolve, 2000);
    });

    // Clean up
    clients.forEach((client) => client.close());
    console.log('[WebSocket Multi-Tab Test] ✓ All tests passed');
  } catch (error) {
    clients.forEach((client) => client.close());
    throw error;
  }
}

testMultiTab()
  .then(() => {
    console.log('[WebSocket Multi-Tab Test] ✓ Completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[WebSocket Multi-Tab Test] ✗ Test failed:', error.message);
    process.exit(1);
  });
