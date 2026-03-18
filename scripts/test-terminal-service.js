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
const NODE_PTY_MOCK_PATH = path.join(__dirname, 'test-terminal-node-pty-mock.js');
const TEST_TOKEN = 'test-token-12345';
const TEST_PORT = 3458;

class TerminalClient {
  constructor() {
    this.socket = null;
    this.buffer = '';
    this.messageQueue = new Map();
    this.messageId = 0;
    this.authenticated = false;
    this.receivedMessages = [];
    this.waiters = [];
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
          } else {
            this.receivedMessages.push(message);
            this.flushWaiters();
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

  async attachSession(sessionId) {
    return this.sendMessage('attach', { sessionId });
  }

  async sendInput(sessionId, data) {
    return this.sendMessage('input', { sessionId, data });
  }

  async terminateAll(ownerId) {
    return this.sendMessage('terminateAll', { ownerId });
  }

  flushWaiters() {
    const pendingWaiters = [...this.waiters];
    this.waiters = [];
    for (const waiter of pendingWaiters) {
      if (!waiter()) {
        this.waiters.push(waiter);
      }
    }
  }

  waitForMessage(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== check);
        reject(new Error('Timed out waiting for terminal message'));
      }, timeoutMs);

      const check = () => {
        const match = this.receivedMessages.find(predicate);
        if (!match) {
          return false;
        }
        clearTimeout(timer);
        resolve(match);
        return true;
      };

      if (!check()) {
        this.waiters.push(check);
      }
    });
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
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${NODE_PTY_MOCK_PATH}`].filter(Boolean).join(' '),
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

    // Test 4: Control socket should not receive terminal output before attach
    console.log('5. Testing control/output separation...');
    await client.sendInput(sessionId, 'printf "control-only\\n"\n');
    await new Promise(resolve => setTimeout(resolve, 500));
    const controlOutput = client.receivedMessages.find((message) => message.type === 'output');
    assert.strictEqual(controlOutput, undefined, 'Control socket should not receive terminal output');
    console.log('   ✓ Control socket stayed response-only\n');

    // Test 5: Attach stream client and receive ready + buffered output
    console.log('6. Testing attach and buffered output...');
    const streamClient = new TerminalClient();
    await streamClient.connect(TEST_PORT);
    await streamClient.authenticate(TEST_TOKEN);
    await streamClient.attachSession(sessionId);
    await streamClient.waitForMessage((message) => message.type === 'ready');
    const bufferedOutput = await streamClient.waitForMessage(
      (message) => message.type === 'output' && typeof message.data === 'string' && message.data.includes('control-only')
    );
    assert(bufferedOutput, 'Expected buffered terminal output after attach');
    await client.sendInput(sessionId, 'printf "after-attach\\n"\n');
    const liveOutput = await streamClient.waitForMessage(
      (message) => message.type === 'output' && typeof message.data === 'string' && message.data.includes('after-attach')
    );
    assert(liveOutput, 'Expected live terminal output after attach');
    console.log('   ✓ Attach receives ready and terminal output\n');

    // Test 6: terminateAll should be owner-scoped
    console.log('7. Testing terminateAll owner scoping...');
    const ownerSessionA = 'owner-session-a';
    const ownerSessionB = 'owner-session-b';
    const otherOwnerSession = 'other-owner-session';
    await client.createSession(ownerSessionA, 'owner-a');
    await client.createSession(ownerSessionB, 'owner-a');
    await client.createSession(otherOwnerSession, 'owner-b');
    const terminateAllResult = await client.terminateAll('owner-a');
    assert.strictEqual(terminateAllResult.success, true, 'terminateAll should succeed');
    assert.strictEqual(terminateAllResult.closed, 2, 'terminateAll should only close matching owner sessions');
    try {
      await client.sendInput(ownerSessionA, 'echo "should fail"\n');
      assert.fail('Expected terminated session input to fail');
    } catch (error) {
      assert.match(String(error), /Session not found/);
    }
    await client.sendInput(otherOwnerSession, 'printf "owner-b-still-live\\n"\n');
    console.log('   ✓ terminateAll only closed the requested owner sessions\n');

    // Test 7: Invalid auth
    console.log('8. Testing invalid authentication...');
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

    // Test 8: Unauthorized request
    console.log('9. Testing unauthorized request...');
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
    streamClient.disconnect();
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
