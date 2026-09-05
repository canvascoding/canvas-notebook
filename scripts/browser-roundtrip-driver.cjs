/* eslint-disable @typescript-eslint/no-require-imports */
// Explicit dev-server preload for the real Notebook browser roundtrip test.
// There is no HTTP test endpoint and this file is never imported by the app.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const socketPath = process.env.CANVAS_BROWSER_ROUNDTRIP_SOCKET;
if (socketPath && path.basename(process.argv[1] || '') === 'server.js') {
  if (process.env.NODE_ENV === 'production') throw new Error('Browser roundtrip driver is dev-only.');
  const directory = fs.statSync(path.dirname(socketPath));
  if (!path.isAbsolute(socketPath) || !directory.isDirectory() || (directory.mode & 0o077) !== 0) {
    throw new Error('Browser roundtrip socket requires a private absolute directory (mode 0700).');
  }

  async function execute(request) {
    // Defer imports until server.js has installed its TS/package/server-only loaders.
    const { auth } = require('../app/lib/auth');
    const identity = await auth.api.getSession({ headers: new Headers({ cookie: request.cookie || '' }) });
    if (!identity?.user?.id) throw new Error('Authentication required.');
    const userId = identity.user.id;
    const { assertUnambiguousOwnedPiSessionForRuntime } = require('../app/lib/pi/session-runtime-access');
    const { resolveAgentExecutionContextForSession } = require('../app/lib/pi/session-workspace-context');
    const session = await assertUnambiguousOwnedPiSessionForRuntime({
      sessionId: request.sessionId, agentId: request.agentId, userId,
    });
    if (request.command === 'runtime_status') {
      return require('../app/lib/pi/runtime-service').getStatus(session.sessionId, userId);
    }
    if (request.command !== 'tool' || !['start', 'status', 'observe', 'evaluate', 'close'].includes(request.input?.action)) {
      throw new Error('Unsupported roundtrip command.');
    }
    const context = await resolveAgentExecutionContextForSession({ sessionId: session.sessionId, agentId: session.agentId, userId });
    const { createBrowserGatewayTool } = require('../app/lib/pi/browser/tool');
    return createBrowserGatewayTool(context).execute('browser-roundtrip-test', request.input);
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(60_000, () => socket.destroy());
    let buffer = '';
    let handled = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void Promise.resolve().then(() => execute(JSON.parse(buffer.slice(0, newline))))
        .then((result) => socket.end(JSON.stringify({ result }) + '\n'))
        .catch((error) => socket.end(JSON.stringify({ error: error.message }) + '\n'));
    });
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  server.unref();
  process.on('exit', () => { try { fs.unlinkSync(socketPath); } catch {} });
}
