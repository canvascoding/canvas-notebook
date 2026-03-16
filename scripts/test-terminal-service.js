/**
 * Terminal Service Integration Tests
 * 
 * Tests the Unix Socket / TCP communication with the terminal service
 */

const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const TERMINAL_SERVICE_PATH = path.join(__dirname, '..', 'server', 'terminal-service.js');
const TEST_TOKEN = 'test-token-12345';
const TEST_PORT = 3458;

class TerminalClient {
  constructor() {
    this.socket = null;
    this.buffer = '';
    this.messageQueue = new Map();
    this.messageId = 0;
    this.authenticated = false;
  }

  async connect(port) {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      
      this.socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      this.socket.on('error', reject);
      this.socket.on('connect', resolve);

      this.socket.connect(port, '127.0.0.1');
    });
  }

  handleData(data) {
    this.buffer += data;
    
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          const pending = this.messageQueue.get(message.id);
          if (pending) {
            this.messageQueue.delete(message.id);
            if (message.error) {
              pending.reject(new Error(message.error.message));
            } else {
              pending.resolve(message.result);
            }
          }
        } catch (e) {
          // Invalid JSON
        }
      }
    }
  }

  async sendMessage(method, params) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${this.messageId++}`;
      const message = { id, method, params };
      
      this.messageQueue.set(id, { resolve, reject });
      
      this.socket.write(JSON.stringify(message) + '\n', (err) => {
        if (err) {
          this.messageQueue.delete(id);
          reject(err);
        }
      });

      setTimeout(() => {
        if (this.messageQueue.has(id)) {
          this.messageQueue.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 5000);
    });
  }

  async authenticate(token) {
    const result = await this.sendMessage('auth', { token });
    this.authenticated = true;
    return result;
  }

  async createSession(sessionId, ownerId) {
    return this.sendMessage('create', { sessionId, ownerId });
  }

  async sendInput(sessionId, data) {
    return this.sendMessage('input', { sessionId, data });
  }

  disconnect() {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }
}

async function runTests() {
  console.log('Starting Terminal Service tests...\n');
  
  // Start terminal service
  console.log('1. Starting terminal service...');
  const terminalService = spawn('node', [TERMINAL_SERVICE_PATH], {
    env: {
      ...process.env,
      CANVAS_TERMINAL_TOKEN: TEST_TOKEN,
      CANVAS_TERMINAL_PORT: String(TEST_PORT),
      CANVAS_TERMINAL_USE_UNIX_SOCKET: 'false',
      TERMINAL_DEBUG: 'true',
    },
    stdio: 'pipe',
  });

  // Wait for service to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log('   ✓ Terminal service started\n');

  try {
    // Test 1: Connection
    console.log('2. Testing connection...');
    const client = new TerminalClient();
    await client.connect(TEST_PORT);
    console.log('   ✓ Connected to terminal service\n');

    // Test 2: Authentication
    console.log('3. Testing authentication...');
    await client.authenticate(TEST_TOKEN);
    console.log('   ✓ Authenticated successfully\n');

    // Test 3: Create session
    console.log('4. Testing session creation...');
    const sessionId = 'test-session-1';
    const ownerId = 'test-user';
    const result = await client.createSession(sessionId, ownerId);
    assert(result.success, 'Session creation failed');
    assert(result.sessionId === sessionId, 'Session ID mismatch');
    console.log('   ✓ Session created:', result.sessionId, '(PID:', result.pid + ')\n');

    // Test 4: Send input
    console.log('5. Testing input...');
    await client.sendInput(sessionId, 'echo "Hello from test"\n');
    console.log('   ✓ Input sent\n');

    // Wait for output
    await new Promise(resolve => setTimeout(resolve, 500));

    // Test 5: Invalid auth
    console.log('6. Testing invalid authentication...');
    const badClient = new TerminalClient();
    await badClient.connect(TEST_PORT);
    try {
      await badClient.authenticate('wrong-token');
      console.log('   ✗ Should have failed with wrong token');
      process.exit(1);
    } catch (e) {
      console.log('   ✓ Correctly rejected invalid token\n');
    }
    badClient.disconnect();

    // Test 6: Unauthorized request
    console.log('7. Testing unauthorized request...');
    const unauthClient = new TerminalClient();
    await unauthClient.connect(TEST_PORT);
    try {
      await unauthClient.createSession('test', 'user');
      console.log('   ✗ Should have failed without auth');
      process.exit(1);
    } catch (e) {
      console.log('   ✓ Correctly rejected unauthorized request\n');
    }
    unauthClient.disconnect();

    // Cleanup
    client.disconnect();
    
    console.log('✅ All tests passed!');
  } finally {
    // Stop terminal service
    terminalService.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!terminalService.killed) {
      terminalService.kill('SIGKILL');
    }
  }
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
