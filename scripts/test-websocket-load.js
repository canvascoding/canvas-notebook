#!/usr/bin/env node
/**
 * WebSocket Load Test
 * 
 * Tests WebSocket server performance under load.
 * 
 * Usage:
 *   npm run test:websocket:load
 */

const WebSocket = require('ws');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace('http:', 'ws:').replace('https:', 'wss:') + '/ws/chat';
const NUM_CLIENTS = parseInt(process.env.WEBSOCKET_LOAD_CLIENTS || '10', 10);
const MESSAGE_INTERVAL = parseInt(process.env.WEBSOCKET_LOAD_INTERVAL || '100', 10);

console.log('[WebSocket Load Test] Testing with', NUM_CLIENTS, 'clients');

async function createClient(clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const stats = { connected: false, messages: 0, errors: 0 };
    
    ws.on('open', () => {
      stats.connected = true;
      resolve({ ws, stats });
    });

    ws.on('message', () => {
      stats.messages++;
    });

    ws.on('error', (error) => {
      stats.errors++;
      reject(error);
    });
  });
}

async function testLoad() {
  const startTime = Date.now();
  const clients = [];
  
  try {
    // Create clients
    console.log('[WebSocket Load Test] Creating', NUM_CLIENTS, 'clients...');
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const client = await createClient(i + 1);
      clients.push(client);
    }

    const connectTime = Date.now() - startTime;
    console.log('[WebSocket Load Test] ✓ All clients connected in', connectTime, 'ms');

    // Send messages
    console.log('[WebSocket Load Test] Sending messages...');
    const messagePromises = [];
    
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const promise = new Promise((resolve) => {
        const interval = setInterval(() => {
          if (clients[i].ws.readyState === WebSocket.OPEN) {
            clients[i].ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          }
        }, MESSAGE_INTERVAL);
        
        setTimeout(() => {
          clearInterval(interval);
          resolve();
        }, 5000);
      });
      
      messagePromises.push(promise);
    }

    await Promise.all(messagePromises);

    // Collect stats
    const totalMessages = clients.reduce((sum, c) => sum + c.stats.messages, 0);
    const totalErrors = clients.reduce((sum, c) => sum + c.stats.errors, 0);
    const totalTime = Date.now() - startTime;

    console.log('[WebSocket Load Test] Results:');
    console.log('  - Total time:', totalTime, 'ms');
    console.log('  - Total messages:', totalMessages);
    console.log('  - Total errors:', totalErrors);
    console.log('  - Messages per second:', Math.round(totalMessages / (totalTime / 1000)));

    // Clean up
    clients.forEach((client) => client.ws.close());
    
    if (totalErrors > 0) {
      throw new Error(`${totalErrors} errors occurred during load test`);
    }
    
    console.log('[WebSocket Load Test] ✓ All tests passed');
  } catch (error) {
    clients.forEach((client) => client.ws.close());
    throw error;
  }
}

testLoad()
  .then(() => {
    console.log('[WebSocket Load Test] ✓ Completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[WebSocket Load Test] ✗ Test failed:', error.message);
    process.exit(1);
  });
