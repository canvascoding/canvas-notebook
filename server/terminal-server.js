/* eslint-disable @typescript-eslint/no-require-imports */
const { WebSocketServer } = require('ws');
const { createSession, attachClient, handleMessage } = require('./terminal-manager');
const { auth } = require('../app/lib/auth.ts');

// Helper to get session from a Node.js HTTP request for WebSockets
async function getSessionFromUpgradeRequest(req) {
  try {
    // Construct a Web API Headers object from the Node.js headers
    const webHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        webHeaders.append(key, value);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          webHeaders.append(key, v);
        }
      }
    }
    
    // Use the official getSession API with the constructed headers
    const session = await auth.api.getSession({ headers: webHeaders });
    return session;
  } catch (e) {
    console.error('[Terminal Auth] Error verifying session:', e);
    return null;
  }
}

function attachTerminalServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/terminal/')) {
      return;
    }

    getSessionFromUpgradeRequest(req)
      .then((sessionData) => {
        if (!sessionData || !sessionData.user) {
          console.warn('[Terminal] Unauthorized connection attempt');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, async (ws) => {
          const parts = url.pathname.split('/');
          const sessionId = parts[parts.length - 1] || 'default';

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
      .catch((err) => {
        console.error('[Terminal] Failed to process session on upgrade:', err);
        socket.destroy();
      });
  });
}

module.exports = { attachTerminalServer };

