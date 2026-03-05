/* eslint-disable @typescript-eslint/no-require-imports */
const { WebSocketServer } = require('ws');
const { createSession, attachClient, handleMessage } = require('./terminal-manager');

const terminalDebug = process.env.TERMINAL_DEBUG === 'true';

let auth;
try {
  const authModule = require('../app/lib/auth');
  auth = authModule.auth || authModule.default?.auth || authModule;
} catch (e) {
  console.error('[Terminal Server] Failed to load auth module:', e.message);
}

async function getSessionFromUpgradeRequest(req) {
  if (!auth) return null;
  try {
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
    
    return await auth.api.getSession({ headers: webHeaders });
  } catch (e) {
    console.error('[Terminal Auth] Error:', e);
    return null;
  }
}

function attachTerminalServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.prependListener('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (!url.pathname.startsWith('/api/terminal/')) {
      return;
    }

    if (terminalDebug) {
      console.log(`[Terminal] Upgrade Request: ${url.pathname}`);
      console.log(`[Terminal] Cookies: ${req.headers.cookie ? 'Present' : 'NONE'}`);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const parts = url.pathname.split('/');
      const sessionId = parts[parts.length - 1] || 'default';

      void (async () => {
        const sessionData = await getSessionFromUpgradeRequest(req);
        if (!sessionData || !sessionData.user) {
          console.warn('[Terminal] Unauthorized connection attempt');
          ws.close(1008, 'Unauthorized');
          return;
        }

        if (terminalDebug) {
          console.log(`[Terminal] User ${sessionData.user.email} authorized`);
        }

        try {
          const session = await createSession(sessionId);
          attachClient(session, ws);

          ws.on('message', (msg) => handleMessage(session, ws, msg));
          ws.on('close', (code, reasonBuffer) => {
            if (!terminalDebug) return;
            const reason = reasonBuffer?.toString?.() || '';
            console.log(`[Terminal] WS Session ${sessionId} closed (code=${code}${reason ? ` reason="${reason}"` : ''})`);
          });
          ws.send(JSON.stringify({ type: 'ready', data: sessionId }));
          if (terminalDebug) {
            console.log(`[Terminal] WS Session ${sessionId} started`);
          }
        } catch (err) {
          const message = err?.message || 'Terminal startup failed';
          console.error('[Terminal] Startup Error:', message);
          ws.close(1013, message);
        }
      })().catch((err) => {
        console.error('[Terminal] Upgrade Auth Error:', err?.message || err);
        try {
          ws.close(1011, 'Internal error');
        } catch {}
      });
    });
  });
}

module.exports = { attachTerminalServer };
