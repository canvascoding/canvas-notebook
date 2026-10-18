import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { WebSocket } from 'ws';
import { Hocuspocus, MessageType } from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual HTTP upgrade/Cookie authorization, Hocuspocus and dedicated PG owner
// sessions. SQL/hook observers preserve real returned rows and authorization.
let groups = 0, completed = false, stage = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
function gate() {
  let finish!: () => void, settled = false;
  const promise = new Promise<void>(done => { finish = done; });
  return { promise, resolve() { settled = true; finish(); }, get settled() { return settled; } };
}
async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(done => setTimeout(done, 20)); }
  throw new Error(label);
}
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}

export async function nativeDocumentSearchRoomPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { createCollaborationServer, flushCollaborationDocuments } = await import('../server/collaboration-server');
    const { createCollaborationRoomOwnerSession, lockIdentity } = await import('../app/lib/collaboration/room-owner');
    const { captureLocalCollaborationSearchRooms } = await import('../app/lib/collaboration/search-room-census');
    const { issueCollaborationTicket } = await import('../app/lib/collaboration/ticket');
    const { searchDocumentsForRequest, readDocumentForRequest } = await import('../app/lib/documents/service');
    type Session = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;
    const ownClients = new Set<Client>(), ownerSessions = new Set<Session>();
    const ownerBackends: Array<{ pid: number; start: string }> = [];
    const ownSession = async (onInvalidated: () => void = () => undefined): Promise<Session> => {
      const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: h.applicationName,
        options: `-c search_path=${h.schema},pg_catalog -c statement_timeout=15000`, connectionTimeoutMillis: 5000 });
      ownClients.add(client); client.on('error', () => undefined); await client.connect();
      const identity = (await client.query(`SELECT current_schema() AS schema,pg_backend_pid() AS pid,
        extract(epoch FROM backend_start)::text AS start FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
      assert.equal(identity.schema, h.schema); ownerBackends.push({ pid: identity.pid, start: identity.start });
      const session = await createCollaborationRoomOwnerSession({ query: client.query.bind(client), on: client.on.bind(client),
        end: async () => { await client.end(); ownClients.delete(client); } }, onInvalidated);
      ownerSessions.add(session); return session;
    };
    const seed = async (file: string, text: string): Promise<CollaborationRoomOwnerScope> => {
      const native = await h.upload(file, Buffer.from(text));
      const doc = createPlainTextYDoc(text);
      try {
        // Genuine fixture data arrangement, before server admission. Existing
        // registry/lineage/import rows come from the actual upload service.
        await h.admin.query(`UPDATE collaboration_yjs_states SET representation='plain_text',yjs_state=$2,state_vector=$3,
          document_sequence=document_sequence+1,checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,
          serialized_hash=NULL WHERE document_id=$1 AND workspace_id=$4 AND status='active'`,
        [native.documentId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), h.source.workspaceId]);
      } finally { doc.destroy(); }
      const row = (await h.admin.query(`SELECT d.lineage_id,s.lifecycle_generation,s.schema_version FROM collaboration_documents d
        JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1 AND d.status='active'`, [native.documentId])).rows[0];
      assert(row?.lineage_id);
      return { documentId: native.documentId, workspaceId: h.source.workspaceId, organizationId: h.source.organizationId ?? null,
        path: file, representation: 'plain_text', lifecycleGeneration: Number(row.lifecycle_generation), schemaVersion: Number(row.schema_version) };
    };
    const local = await seed('local-live/native.md', 'Durable original body.'), remote = await seed('remote-only/native.md', 'Remote needle body.');
    const server = http.createServer((_request, response) => { response.statusCode = 404; response.end(); });
    const sockets = new Set<WebSocket>(), clientDocs = new Set<InstanceType<typeof Y.Doc>>();
    const documents = new Map<string, import('@hocuspocus/server').Document>();
    let runtime: Hocuspocus | undefined;
    let storePause: { documentId: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate>; finished: ReturnType<typeof gate> } | undefined;
    const originalHooks = Hocuspocus.prototype.hooks;
    let wss: ReturnType<typeof createCollaborationServer> | undefined;
    try {
    Hocuspocus.prototype.hooks = (async function(this: Hocuspocus, name: string, payload: Record<string, unknown>, ...args: unknown[]) {
      // The factory hides its server instance; retain the actual hook receiver for awaited fixture cleanup.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      runtime = this;
      const pause = storePause;
      if (name === 'onStoreDocument' && pause && pause.documentId === payload.documentName) {
        pause.entered.resolve(); await bounded(pause.release.promise, 'Owned store barrier was not released.', 20_000);
        try { return await Reflect.apply(originalHooks, this, [name, payload, ...args]); }
        finally { pause.finished.resolve(); }
      }
      const result = await Reflect.apply(originalHooks, this, [name, payload, ...args]);
      if (name === 'connected' && typeof payload.documentName === 'string' && payload.connection) {
        documents.set(payload.documentName, (payload.connection as import('@hocuspocus/server').Connection).document);
      }
      return result;
    }) as typeof originalHooks;
    wss = createCollaborationServer(server, { roomOwner: { createSession: ownSession, heartbeatMs: 1000 } });
    const frame = (id: string, type: number, write: (encoder: ReturnType<typeof encoding.createEncoder>) => void) => {
      const encoder = encoding.createEncoder(); encoding.writeVarString(encoder, id); encoding.writeVarUint(encoder, type); write(encoder);
      return encoding.toUint8Array(encoder);
    };
    const readStored = async (id: string) => {
      const row = (await h.admin.query(`SELECT yjs_state,state_vector,document_sequence,persisted_at FROM collaboration_yjs_states WHERE document_id=$1`, [id])).rows[0];
      assert(row); const doc = new Y.Doc();
      try { Y.applyUpdate(doc, new Uint8Array(row.yjs_state)); return { ...row, text: doc.getText('content').toString() }; }
      finally { doc.destroy(); }
    };
      await bounded(new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => reject(error); server.once('error', fail);
        server.listen(0, '127.0.0.1', () => { server.off('error', fail); resolve(); });
      }), 'Owned HTTP server did not listen.'); const address = server.address(); assert(address && typeof address === 'object');
      const original = await h.request(h.source, 'owner', true);
      const ticket = issueCollaborationTicket({ userId: 'owner', sessionId: 'session-owner', ...local, provider: 'yjs', permission: 'write' });
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`, { headers: {
        origin: 'http://localhost', cookie: original.headers.get('cookie') ?? '', 'x-canvas-workspace-id': h.source.workspaceId } });
      sockets.add(socket); const clientDoc = new Y.Doc(); clientDocs.add(clientDoc);
      let authenticated = false, denied = false, startup = false, frameError: unknown;
      socket.on('error', error => { frameError = error; });
      socket.on('message', data => {
        try {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const decoder = decoding.createDecoder(bytes); assert.equal(decoding.readVarString(decoder), local.documentId);
          const type = decoding.readVarUint(decoder);
          if (type === MessageType.Auth) { const auth = decoding.readVarUint(decoder); authenticated ||= auth === AuthMessageType.Authenticated; denied ||= auth === AuthMessageType.PermissionDenied; }
          if (type === MessageType.Stateless) startup ||= JSON.parse(decoding.readVarString(decoder)).type === 'durability_snapshot';
          if (type === MessageType.Sync) { const subtype = decoding.readVarUint(decoder); if (subtype === 1 || subtype === 2) Y.applyUpdate(clientDoc, decoding.readVarUint8Array(decoder)); }
        } catch (error) { frameError = error; }
      });
      await bounded(new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }), 'Owned Socket did not open.');
      socket.send(frame(local.documentId, MessageType.Auth, encoder => { encoding.writeVarUint(encoder, AuthMessageType.Token); encoding.writeVarString(encoder, ticket.token); }));
      await until(() => authenticated || denied || Boolean(frameError), 'Actual Cookie Socket authentication did not settle.');
      assert.equal(frameError, undefined); assert(authenticated && !denied);
      await until(() => startup && documents.has(local.documentId), 'Actual room did not finish startup.');
      socket.send(frame(local.documentId, MessageType.Sync, encoder => { encoding.writeVarUint(encoder, 0); encoding.writeVarUint8Array(encoder, Y.encodeStateVector(clientDoc)); }));
      await until(() => clientDoc.getText('content').toString() === 'Durable original body.', 'Actual Socket did not synchronize the stored source.');
      await flushCollaborationDocuments();

      stage = 'live unsaved source';
      const stored = await readStored(local.documentId), phrase = ' freshneedle😀 unsaved';
      await fs.writeFile(path.join(h.source.rootPath, local.path), 'Physical stale-only phrase.');
      await fs.unlink(path.join(h.source.rootPath, local.path));
      storePause = { documentId: local.documentId, entered: gate(), release: gate(), finished: gate() };
      const vector = Y.encodeStateVector(clientDoc); clientDoc.getText('content').insert(clientDoc.getText('content').length, phrase);
      socket.send(frame(local.documentId, MessageType.Sync, encoder => { encoding.writeVarUint(encoder, 2); encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(clientDoc, vector)); }));
      await bounded(storePause.entered.promise, 'The actual accepted Socket update did not reach Store.');
      assert.equal(documents.get(local.documentId)?.getText('content').toString(), stored.text + phrase);
      assert.deepEqual(await readStored(local.documentId), stored, 'The pause must precede genuine durable persistence.');
      const census = captureLocalCollaborationSearchRooms(h.source.workspaceId, 4096, 'exclude_dot_segments');
      assert(census.complete && census.rooms.some(room => room.documentId === local.documentId));
      const page = await searchDocumentsForRequest(await h.request(h.source, 'member', true),
        { apiVersion: 1, workspaceId: h.source.workspaceId, query: 'freshneedle', scopePath: 'local-live' });
      assert.equal(page.hits.length, 1); const hit = page.hits[0]; assert.equal(hit.document.documentId, local.documentId);
      assert.equal(hit.currency.source, 'live_yjs'); assert.equal(hit.currency.observedDurable, false);
      assert.notEqual(hit.document.version, hit.currency.durableVersion); assert.equal(page.coverage.localLive, 'verified');
      assert.equal(page.coverage.remoteLive, 'unknown'); assert.equal(page.coverage.globalCurrentContent, 'not_certified');
      const read = await readDocumentForRequest(await h.request(h.source, 'member', true), { apiVersion: 1,
        workspaceId: h.source.workspaceId, documentId: hit.document.documentId, expectedVersion: hit.document.version, format: 'text' });
      assert.equal(read.fragment, stored.text + phrase); assert.equal(read.document.version, hit.document.version);
      assert.deepEqual(await readStored(local.documentId), stored); await assert.rejects(fs.lstat(path.join(h.source.rootPath, local.path)), { code: 'ENOENT' });
      storePause.release.resolve(); await bounded(storePause.finished.promise, 'Actual Store did not finish after release.'); storePause = undefined;
      await flushCollaborationDocuments(); assert.equal((await readStored(local.documentId)).text, stored.text + phrase);
      const race = { documentId: local.documentId, entered: gate(), release: gate(), finished: gate() };
      storePause = race; let raceSent = false;
      try {
        await h.withProbe(async event => {
          if (raceSent || !event.text.includes('s.yjs_state,s.state_vector') || event.values[0] !== local.documentId) return;
          raceSent = true; const oldVector = Y.encodeStateVector(clientDoc), suffix = ' latercollision';
          clientDoc.getText('content').insert(clientDoc.getText('content').length, suffix);
          socket.send(frame(local.documentId, MessageType.Sync, encoder => { encoding.writeVarUint(encoder, 2);
            encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(clientDoc, oldVector)); }));
          await until(() => documents.get(local.documentId)?.getText('content').toString() === stored.text + phrase + suffix,
            'Actual Socket race did not change the loaded Room.');
          await bounded(race.entered.promise, 'Actual Socket race never reached the owned Store barrier.');
        }, async () => assert.rejects(searchDocumentsForRequest(await h.request(h.source, 'member', true),
          { apiVersion: 1, workspaceId: h.source.workspaceId, query: 'freshneedle', scopePath: 'local-live' }), error =>
          Boolean(error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'SEARCH_CORPUS_CHANGED'
            && Object.getOwnPropertyDescriptor(error, 'status')?.value === 409)));
        assert(raceSent && race.entered.settled);
      } finally {
        race.release.resolve();
        if (race.entered.settled) await bounded(race.finished.promise, 'Actual race Store did not finish during release.');
        storePause = undefined; await flushCollaborationDocuments();
      }
      console.log('PASS actual Socket unsaved Yjs search/ID read and actual Room-update final-check rejection'); groups++;

      stage = 'remote actual owner';
      const foreign = await ownSession(), foreignFence = await foreign.acquire(remote), lock = lockIdentity(remote.documentId);
      try {
        const held = (await h.admin.query(`SELECT l.pid,extract(epoch FROM a.backend_start)::text AS start FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
          AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.classid::bigint=$1
          AND l.objid::bigint=$2 AND l.objsubid=1 AND l.pid=$3`, [lock.high, lock.low, foreignFence.backendPid])).rows;
        assert.deepEqual(held, [{ pid: foreignFence.backendPid, start: foreignFence.backendStart }]);
        const localOnly = captureLocalCollaborationSearchRooms(h.source.workspaceId, 4096, 'exclude_dot_segments');
        assert.equal(localOnly.coversOwner(foreignFence), false); assert.equal(documents.has(remote.documentId), false);
        const before = await readStored(remote.documentId);
        const unavailable = await searchDocumentsForRequest(await h.request(h.source, 'member', true),
          { apiVersion: 1, workspaceId: h.source.workspaceId, query: 'needle', scopePath: 'remote-only' });
        assert.deepEqual(unavailable.hits, []); assert.equal(unavailable.coverage.excludedInWindow.unavailableOwner, 1);
        assert.equal(unavailable.coverage.remoteLive, 'unknown'); assert.equal(unavailable.coverage.globalCurrentContent, 'not_certified');
        assert.deepEqual(await readStored(remote.documentId), before);
      } finally { await foreign.release(foreignFence); await foreign.close(); }
      const idle = await searchDocumentsForRequest(await h.request(h.source, 'member', true),
        { apiVersion: 1, workspaceId: h.source.workspaceId, query: 'needle', scopePath: 'remote-only' });
      assert.equal(idle.hits.length, 1); assert.equal(idle.hits[0].document.documentId, remote.documentId);
      assert.equal(idle.hits[0].currency.source, 'persisted_yjs'); assert.equal(idle.hits[0].currency.observedDurable, true);
      console.log('PASS genuine nonlocal SQL owner is explicitly unavailable until exact owner release, never stale-current fallback'); groups++;
    } finally {
      const cleanup: unknown[] = []; storePause?.release.resolve();
      if (storePause?.entered.settled) try { await bounded(storePause.finished.promise, 'Owned paused Store did not settle during cleanup.'); } catch (error) { cleanup.push(error); }
      storePause = undefined;
      for (const socket of sockets) socket.terminate();
      try { await until(() => [...documents.values()].every(document => document.getConnectionsCount() === 0), 'Owned Socket connections remain.'); await flushCollaborationDocuments(); } catch (error) { cleanup.push(error); }
      if (runtime) {
        for (const document of [...runtime.documents.values()]) try { await runtime.unloadDocument(document); } catch (error) { cleanup.push(error); }
        for (const pending of [...runtime.unloadingDocuments.values()]) try { await pending; } catch (error) { cleanup.push(error); }
      }
      if (wss) try { await bounded(new Promise<void>((resolve, reject) => wss!.close(error => error ? reject(error) : resolve())), 'Owned WSS did not close.'); } catch (error) { cleanup.push(error); }
      try { await bounded(new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())), 'Owned HTTP server did not close.'); } catch (error) { cleanup.push(error); }
      for (const session of ownerSessions) try { await session.close(); } catch (error) { cleanup.push(error); }
      for (const client of ownClients) try { await client.end(); ownClients.delete(client); } catch (error) { cleanup.push(error); }
      for (const document of documents.values()) document.destroy(); for (const document of clientDocs) document.destroy();
      Hocuspocus.prototype.hooks = originalHooks;
      for (const backend of ownerBackends) try { assert.equal((await h.admin.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2`, [backend.pid, backend.start])).rows[0].n, 0); } catch (error) { cleanup.push(error); }
      if (cleanup.length) throw new AggregateError(cleanup, 'Actual search room resources did not close cleanly.');
      console.log(JSON.stringify({ closure: 'native-document-search-room', socketsClosed: true, serversClosed: true, dedicatedOwnerBackendsClosed: ownerBackends.length }));
    }
  });
  assert.equal(groups, 2); completed = true;
  console.log(JSON.stringify({ suite: 'native-document-search-room', groups, evidence: 'actual_socket_principal_pg_owner_and_native_service' }));
}

nativeDocumentSearchRoomPostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'native-document-search-room', stage, groups, name: error instanceof Error ? error.name : 'UnknownError',
    code: error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value ?? null : null }));
  console.error(error); process.exitCode = 1;
});
