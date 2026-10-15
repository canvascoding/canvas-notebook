import type { BrowserContext, WebSocketRoute } from '@playwright/test';

type Channel = {
  client: WebSocketRoute;
  server: WebSocketRoute | null;
  clientClosed: boolean;
  serverClosed: boolean;
  observedClose?: () => void;
  closing?: Promise<void>;
};

/** Test-owned transport interruption; never fabricates authentication, Yjs data or acknowledgements. */
export async function installOwnedCollaborationOutage(context: BrowserContext): Promise<{
  block(): Promise<void>;
  restore(): void;
  dispose(): Promise<void>;
}> {
  const channels = new Set<Channel>();
  const closeOptions = { code: 4000, reason: 'Owned collaboration outage' };
  const maxChannels = 16, maxRoutes = 128, maxDroppedFrames = 4096;
  let blocked = false, disposed = false, routes = 0, connected = 0, droppedFrames = 0;
  let failure: Error | undefined, blocking: Promise<void> | undefined, disposal: Promise<void> | undefined;
  const fail = (code: string) => { failure ??= new Error(code); blocked = true; };
  const assertHealthy = () => { if (failure) throw failure; };
  const observed = (channel: Channel) => {
    if (channel.clientClosed && channel.serverClosed) {
      channels.delete(channel);
      channel.observedClose?.();
    }
  };
  const close = (channel: Channel): Promise<void> => {
    if (channel.closing) return channel.closing;
    channel.closing = (async () => {
      if (channel.clientClosed && channel.serverClosed) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const receipt = new Promise<void>((resolve, reject) => {
        channel.observedClose = resolve;
        timer = setTimeout(() => reject(new Error('OWNED_COLLABORATION_CLOSE_UNCONFIRMED')), 5000);
      });
      try {
        // Playwright close() catches channel errors internally. Only actual
        // onClose callbacks below can complete the independent close receipt.
        await Promise.all([channel.client.close(closeOptions), channel.server?.close(closeOptions), receipt]);
      } finally {
        if (timer) clearTimeout(timer);
        channel.observedClose = undefined;
      }
    })();
    void channel.closing.catch(() => fail('OWNED_COLLABORATION_CLOSE_UNCONFIRMED'));
    return channel.closing;
  };
  const closeAll = async () => {
    const results = await Promise.allSettled([...channels].map(close));
    if (results.some(result => result.status === 'rejected')) fail('OWNED_COLLABORATION_CLOSE_UNCONFIRMED');
    assertHealthy();
  };
  const dropped = () => {
    droppedFrames += 1;
    if (droppedFrames === 1) console.warn('[owned-collaboration-outage] Frame withheld while blocked.');
    if (droppedFrames > maxDroppedFrames) fail('OWNED_COLLABORATION_FRAME_LIMIT');
  };

  await context.routeWebSocket(url => url.pathname === '/ws/collaboration', async client => {
    routes += 1;
    if (routes > maxRoutes || channels.size >= maxChannels) {
      fail('OWNED_COLLABORATION_CHANNEL_LIMIT');
      await client.close(closeOptions);
      return;
    }
    let server: WebSocketRoute | null = null;
    if (!blocked && !disposed) {
      try { server = client.connectToServer(); connected += 1; }
      catch { fail('OWNED_COLLABORATION_CONNECT_FAILED'); }
    }
    const channel: Channel = { client, server, clientClosed: false, serverClosed: server === null };
    channels.add(channel);
    client.onMessage(message => {
      if (blocked || disposed || !server) { dropped(); return; }
      server.send(message);
    });
    server?.onMessage(message => {
      if (blocked || disposed) { dropped(); return; }
      client.send(message);
    });
    // Installing onClose disables Playwright's default close forwarding. Keep
    // normal closure propagation while observing both owned sides explicitly.
    client.onClose((code, reason) => {
      channel.clientClosed = true;
      observed(channel);
      if (!channel.serverClosed && server) {
        const allowedCode = code === 1000 || code !== undefined && code >= 3000 && code <= 4999 ? code : undefined;
        void server.close({ code: allowedCode, reason }).catch(() => fail('OWNED_COLLABORATION_CLOSE_UNCONFIRMED'));
      }
    });
    server?.onClose((code, reason) => {
      channel.serverClosed = true;
      observed(channel);
      if (!channel.clientClosed) void client.close({ code, reason }).catch(() => fail('OWNED_COLLABORATION_CLOSE_UNCONFIRMED'));
    });
    if (blocked || disposed || !server) {
      try { await close(channel); }
      catch { fail('OWNED_COLLABORATION_CLOSE_UNCONFIRMED'); }
    }
  });

  return {
    block() {
      // This synchronous flag precedes every close/await, including messages
      // already queued in Playwright and newly attempted reconnects.
      blocked = true;
      if (disposed) return Promise.reject(new Error('OWNED_COLLABORATION_OUTAGE_DISPOSED'));
      if (connected === 0) return Promise.reject(new Error('OWNED_COLLABORATION_CONNECTION_NOT_OBSERVED'));
      return blocking ??= closeAll().finally(() => { blocking = undefined; });
    },
    restore() {
      assertHealthy();
      if (disposed || blocking) throw new Error('OWNED_COLLABORATION_OUTAGE_NOT_RESTORABLE');
      // Only genuine subsequent connection attempts reconnect; no held frames
      // are retained or replayed by this helper.
      blocked = false;
    },
    dispose() {
      disposed = true;
      blocked = true;
      // The installed API has no unrouteWebSocket. This route remains closed
      // until its owning test BrowserContext is destroyed; HTTP routes stay intact.
      return disposal ??= (async () => {
        if (blocking) await blocking.catch(() => fail('OWNED_COLLABORATION_CLOSE_UNCONFIRMED'));
        await closeAll();
        console.info('[owned-collaboration-outage] Closed owned transport.', { routes, connected, droppedFrames });
      })();
    },
  };
}
