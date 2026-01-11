/* eslint-disable @typescript-eslint/no-require-imports */
const { WebSocketServer } = require('ws');
const { createSession, attachClient, handleMessage } = require('./terminal-manager');
const { getSessionFromRequest } = require('./session');

function attachTerminalServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/terminal/')) {
      return;
    }

    getSessionFromRequest(req)
      .then((sessionData) => {
        if (!sessionData || sessionData.isLoggedIn !== true) {
          console.warn('[Terminal] Unauthorized connection attempt');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, async (ws) => {
          const parts = url.pathname.split('/');
          const sessionId = parts[parts.length - 1] || 'default';

          // Send immediate ACK to keep connection alive during async session creation
          ws.send(JSON.stringify({ type: 'ack' }));

          let session;
          try {
            session = await createSession(sessionId);
          } catch (err) {
            console.warn('[Terminal] Failed to create session:', err.message);
            ws.close(1013, err.message || 'Failed to create terminal session');
            return;
          }

          attachClient(session, ws);
          console.log(`[Terminal] Session connected: ${sessionId}`);

          ws.on('message', (message) => {
            handleMessage(session, message);
          });

          ws.send(JSON.stringify({ type: 'ready', data: sessionId }));
        });
      })
      .catch(() => {
        console.warn('[Terminal] Failed to read session');
        socket.destroy();
      });
  });
}

module.exports = { attachTerminalServer };
