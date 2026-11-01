import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from 'pg';
import { Hocuspocus } from '@hocuspocus/server';

/** Actual source runtime for the key Edit route and installed SDK suites.
 * Only observation and fixture-owned database connections are supplied here. */
export async function withNativeApiKeyEditRuntime<T>(
  fixture: { schema: string; applicationName: string },
  consume: (value: { server: http.Server; origin: string; runtime: () => Hocuspocus | undefined }) => Promise<T>,
): Promise<T> {
  const { createCollaborationServer, flushCollaborationDocuments } = await import('../../server/collaboration-server');
  const { createCollaborationRoomOwnerSession } = await import('../../app/lib/collaboration/room-owner');
  const server = http.createServer(); server.requestTimeout = 20000; server.headersTimeout = 10000;
  const clients = new Set<Client>(), ownerSessions = new Set<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>>();
  let runtime: Hocuspocus | undefined, wss: ReturnType<typeof createCollaborationServer> | undefined;
  const originalHooks = Hocuspocus.prototype.hooks;
  try {
    Hocuspocus.prototype.hooks = (async function(this: Hocuspocus, name: string, payload: Record<string, unknown>, ...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      runtime = this; return Reflect.apply(originalHooks, this, [name, payload, ...args]);
    }) as typeof originalHooks;
    wss = createCollaborationServer(server, { roomOwner: { heartbeatMs: 1000, createSession: async onInvalidated => {
      const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: fixture.applicationName,
        options: `-c search_path=${fixture.schema},pg_catalog -c statement_timeout=15000`, connectionTimeoutMillis: 5000 });
      clients.add(client); client.on('error', () => undefined); await client.connect();
      const session = await createCollaborationRoomOwnerSession({ query: client.query.bind(client), on: client.on.bind(client),
        end: async () => { await client.end(); clients.delete(client); } }, onInvalidated);
      ownerSessions.add(session); return session;
    } } });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject); resolve(); }); });
    const address = server.address(); assert(address && typeof address === 'object');
    return await consume({ server, origin: `http://127.0.0.1:${address.port}`, runtime: () => runtime });
  } finally {
    const errors: unknown[] = [];
    try { await flushCollaborationDocuments(); } catch (error) { errors.push(error); }
    if (runtime) {
      for (const doc of [...runtime.documents.values()]) try { await runtime.unloadDocument(doc); } catch (error) { errors.push(error); }
      for (const pending of [...runtime.unloadingDocuments.values()]) try { await pending; } catch (error) { errors.push(error); }
    }
    if (wss) try { await new Promise<void>((resolve, reject) => wss!.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
    if (server.listening) try { await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); } catch (error) { errors.push(error); }
    for (const session of ownerSessions) try { await session.close(); } catch (error) { errors.push(error); }
    for (const client of clients) try { await client.end(); clients.delete(client); } catch (error) { errors.push(error); }
    Hocuspocus.prototype.hooks = originalHooks;
    assert.equal(server.listening, false); assert.equal(clients.size, 0);
    if (errors.length) throw new AggregateError(errors, 'Native API-key test runtime cleanup failed.');
    console.log(JSON.stringify({ suite: 'api-key-native-edit-runtime', roomOwnersClosed: true, listeningHttpServers: 0 }));
  }
}
