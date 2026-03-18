import assert from 'node:assert/strict';

import { resolveTerminalTransport } from '../app/lib/terminal-transport';

const socketPath = '/tmp/terminal-test.sock';

const explicitFalse = resolveTerminalTransport({
  CANVAS_RUNTIME_ENV: 'docker',
  CANVAS_TERMINAL_SOCKET: socketPath,
  CANVAS_TERMINAL_PORT: '4567',
  CANVAS_TERMINAL_USE_UNIX_SOCKET: 'false',
});

assert.equal(explicitFalse.useUnixSocket, false);
assert.equal(explicitFalse.tcpPort, 4567);
assert.equal(explicitFalse.socketPath, socketPath);

const explicitTrue = resolveTerminalTransport({
  CANVAS_RUNTIME_ENV: 'local',
  CANVAS_TERMINAL_USE_UNIX_SOCKET: 'true',
});

assert.equal(explicitTrue.useUnixSocket, true);

const dockerDefault = resolveTerminalTransport({
  CANVAS_RUNTIME_ENV: 'docker',
});

assert.equal(dockerDefault.useUnixSocket, true);

const localDefault = resolveTerminalTransport({
  CANVAS_RUNTIME_ENV: 'local',
});

assert.equal(localDefault.useUnixSocket, false);
assert.equal(localDefault.tcpHost, '127.0.0.1');

console.log('Terminal transport resolution tests passed.');
