import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { Hocuspocus } from '@hocuspocus/server';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import { measureDocumentDatabaseActivity, measureDocumentOperation, withDocumentOperationMetricObserver,
  type DocumentDatabaseActivityMeasurement, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
assert.equal(process.env.NODE_ENV, 'test'); assert(output && path.isAbsolute(output));
const profiles: Array<{ label: string; measurement: DocumentDatabaseActivityMeasurement;
  backendSamples: number; sampledPeakRuntimeBackends: number; sampledPeakDedicatedBackends: number }> = [];
const operations: DocumentOperationMeasurement[] = [];
const admissionPolls: Array<{ startedDuringProfile: string | null; measurement: DocumentOperationMeasurement }> = [];
let activeProfile: string | null = null;
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); }
  throw new Error(label);
}

await withDocumentOperationMetricObserver(value => operations.push(value), () => withNativeCopyMetadataOwnerFixture(async h => {
  // This is an isolated SQL QA fixture. Its actual cookie credentials, native
  // services, HTTP handler and WS transport execute unchanged. No production
  // user, Control Plane grant or browser-UI acceptance is claimed here.
  const { Y } = await import('../app/lib/collaboration/server-runtime');
  const { richMarkdownFromYDoc, replaceRichMarkdownInYDoc } = await import('../app/lib/collaboration/markdown-state');
  const { COLLABORATION_CLIENT_CAPABILITIES } = await import('../app/lib/collaboration/types');
  const { POST: sessionPost } = await import('../app/api/files/collaboration/session/route');
  const { createCollaborationServer, flushCollaborationDocuments } = await import('../server/collaboration-server');
  const { createCollaborationRoomOwnerOptions } = await import('../app/lib/collaboration/room-owner-options');
  const sourcePath = 'profile/normal.md', initial = 'Editor baseline body.';
  const native = await h.upload(sourcePath, Buffer.from(initial));
  const original = await h.request(h.source, 'owner', true);
  const cookie = original.headers.get('cookie') ?? assert.fail('The real fixture cookie is absent.');
  const sourceCount = Number((await h.admin.query("SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND status='active'",
    [h.source.workspaceId])).rows[0].n);
  const runtimeNames = [h.applicationName, `canvas-collaboration-owner-${process.pid}`,
    `canvas-collaboration-release-recovery-${process.pid}`];
  const backendCount = async () => {
    const row = (await h.admin.query(`SELECT count(*)::integer AS total,
      count(*) FILTER(WHERE application_name<>$1)::integer AS dedicated
      FROM pg_stat_activity WHERE datname=current_database() AND application_name=ANY($2::text[])`,
    [h.applicationName, runtimeNames])).rows[0];
    return { total: Number(row.total), dedicated: Number(row.dedicated) };
  };
  const profile = async <T>(label: string, operation: 'read' | 'save', execute: () => Promise<T>): Promise<T> => {
    assert.equal(activeProfile, null); activeProfile = label;
    let stopping = false, backendSamples = 0, peak = 0, dedicatedPeak = 0;
    const sample = async () => {
      do {
        const count = await backendCount(); backendSamples++; peak = Math.max(peak, count.total);
        dedicatedPeak = Math.max(dedicatedPeak, count.dedicated);
        if (!stopping) await new Promise(done => setTimeout(done, 100));
      } while (!stopping);
    };
    // Administrative sampling uses the already owned fixture connection and
    // is excluded from runtime SQL. Sampled maxima are lower bounds, not an
    // exact connection high-water mark or a production latency benchmark.
    const sampling = sample(); sampling.catch(() => undefined);
    try { return await measureDocumentDatabaseActivity(operation, 'request', execute, measurement => {
      profiles.push({ label, measurement, backendSamples, sampledPeakRuntimeBackends: peak,
        sampledPeakDedicatedBackends: dedicatedPeak });
    }); } finally { activeProfile = null; stopping = true; await sampling; }
  };
  const readStored = async () => {
    const row = (await h.admin.query(`SELECT representation,document_sequence,checkpoint_sequence,checkpointed_at,yjs_state
      FROM collaboration_yjs_states WHERE document_id=$1 AND workspace_id=$2 AND status='active'`,
    [native.documentId, h.source.workspaceId])).rows[0]; assert(row);
    const doc = new Y.Doc();
    try { Y.applyUpdate(doc, new Uint8Array(row.yjs_state)); return { sequence: Number(row.document_sequence),
      checkpoint: Number(row.checkpoint_sequence), checkpointed: row.checkpointed_at !== null,
      text: row.representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc) }; }
    finally { doc.destroy(); }
  };
  const projected = async (expected: string) => {
    const row = await readStored();
    if (row.text !== expected || row.sequence !== row.checkpoint || !row.checkpointed) return false;
    try { return await fs.readFile(path.join(h.source.rootPath, sourcePath), 'utf8') === expected; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const requests = new Set<http.ClientRequest>(), sockets = new Set<WebSocket>();
  const rooms: Array<{ provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; document: InstanceType<typeof Y.Doc> }> = [];
  const serverErrors: unknown[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/api/files/collaboration/session') {
        response.writeHead(404); response.end(); return;
      }
      const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const result = await sessionPost(new NextRequest(`http://localhost${request.url}`, {
        method: 'POST', headers, body: Buffer.concat(bytes).toString('utf8'),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(error => { serverErrors.push(error); response.writeHead(500); response.end(); });
  });
  let runtime: Hocuspocus | undefined;
  const pendingHooks = new Set<Promise<unknown>>();
  const originalHooks = Hocuspocus.prototype.hooks;
  Hocuspocus.prototype.hooks = (async function(this: Hocuspocus, ...args: Parameters<Hocuspocus['hooks']>) {
    // Retain the genuine instance solely for bounded resource cleanup.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    runtime = this;
    const pending = Promise.resolve(Reflect.apply(originalHooks, this, args)); pendingHooks.add(pending);
    try { return await pending; } finally { pendingHooks.delete(pending); }
  }) as typeof originalHooks;
  const defaults = createCollaborationRoomOwnerOptions();
  const options = { ...defaults, admission: { ...defaults.admission, pendingDrains: (fences: Parameters<typeof defaults.admission.pendingDrains>[0]) => {
    const startedDuringProfile = activeProfile;
    return withDocumentOperationMetricObserver(measurement => admissionPolls.push({ startedDuringProfile, measurement }),
      () => measureDocumentOperation('read', 'system', () => defaults.admission.pendingDrains(fences)));
  } } };
  assert.equal(options.heartbeatMs, 5000); assert.equal(options.admission.pollMs, 250);
  const wss = createCollaborationServer(server, { roomOwner: options });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert(address && typeof address === 'object');
    const open = async () => {
      const body = JSON.stringify({ path: sourcePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES });
      const session = await new Promise<{ documentId: string; documentName: string; token: string; representation: string; websocketUrl: string }>((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/api/files/collaboration/session',
          headers: { host: 'localhost', origin: 'http://localhost', cookie, 'x-canvas-workspace-id': h.source.workspaceId,
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.once('error', reject); response.once('end', () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              assert.equal(response.statusCode, 200, `Actual session endpoint failed: ${result.code ?? 'unclassified'}`);
              assert.equal(result.success, true); assert(['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(result.representation));
              assert.equal(result.documentId, native.documentId); resolve(result);
            } catch (error) { reject(error); }
          });
        });
        requests.add(request); request.once('close', () => requests.delete(request)); request.once('error', reject);
        request.setTimeout(15_000, () => request.destroy(new Error('Owned HTTP session request timed out.'))); request.end(body);
      });
      class AuthenticatedSocket extends WebSocket {
        constructor(url: string) {
          super(url, { origin: 'http://localhost', headers: { cookie, 'x-canvas-workspace-id': h.source.workspaceId } });
          sockets.add(this); this.once('close', () => sockets.delete(this));
        }
      }
      const document = new Y.Doc();
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${address.port}${session.websocketUrl}`,
        preserveTrailingSlash: true, WebSocketPolyfill: AuthenticatedSocket });
      let denied = false;
      const provider = new HocuspocusProvider({ websocketProvider: socket, name: session.documentName,
        token: session.token, document, onAuthenticationFailed() { denied = true; } });
      const room = { provider, socket, document }; rooms.push(room); provider.attach();
      await until(() => { assert.equal(denied, false, 'The original cookie/ticket was rejected.'); return provider.isSynced; }, 'Actual provider did not synchronize.');
      assert.equal(session.representation === 'plain_text' ? document.getText('content').toString() : richMarkdownFromYDoc(document), (await readStored()).text);
      return room;
    };
    const room = await profile('cold-session-socket-and-initial-projection', 'read', async () => {
      const opened = await open(); await flushCollaborationDocuments();
      await until(() => projected(initial), 'Initial native checkpoint/file did not converge.'); return opened;
    });
    await profile('idle-held-owner-6100ms', 'read', async () => { await new Promise(done => setTimeout(done, 6100)); });
    for (let attempt = 1; attempt <= 2; attempt++) await profile(`warm-save-through-file-checkpoint-${attempt}`, 'save', async () => {
      const previous = await readStored(), next = `${previous.text} Saved ${attempt}.`;
      replaceRichMarkdownInYDoc(room.document, next, 'editor-runtime-baseline');
      await until(async () => (await readStored()).sequence > previous.sequence && await projected(next), 'Actual Save did not reach its native/file checkpoint.');
    });
    await profile('warm-session-and-second-real-peer', 'read', async () => { await open(); });
    assert.equal(serverErrors.length, 0); assert.equal((await readStored()).text, `${initial} Saved 1. Saved 2.`);
    console.log(JSON.stringify({ editorRuntimeBaseline: true, nativeDocuments: sourceCount,
      heartbeatMs: options.heartbeatMs, admissionPollMs: options.admission.pollMs,
      profiles: profiles.map(value => ({ label: value.label, statements: value.measurement.statements,
        checkouts: value.measurement.checkouts, sampledDedicatedBackends: value.sampledPeakDedicatedBackends })) }));
  } finally {
    const failures: unknown[] = [];
    for (const request of requests) request.destroy();
    for (const room of rooms) { room.provider.destroy(); room.socket.destroy(); }
    for (const socket of sockets) socket.terminate();
    if (runtime) {
      try {
        await until(() => sockets.size === 0 && [...runtime!.documents.values()].every(document => document.getConnectionsCount() === 0), 'Owned peers did not disconnect.');
        await flushCollaborationDocuments();
        await until(() => pendingHooks.size === 0, 'Actual in-flight native hooks did not finish before owner release.');
      }
      catch (error) { failures.push(error); }
      for (const document of [...runtime.documents.values()]) try { await runtime.unloadDocument(document); } catch (error) { failures.push(error); }
      for (const pending of [...runtime.unloadingDocuments.values()]) try { await pending; } catch (error) { failures.push(error); }
    }
    try { await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    try { await new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    for (const room of rooms) room.document.destroy(); Hocuspocus.prototype.hooks = originalHooks;
    try { await until(async () => (await backendCount()).dedicated === 0, 'Owned dedicated runtime backends remain.'); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Owned Editor profiler cleanup failed.');
    console.log(JSON.stringify({ closure: 'document-editor-runtime-baseline', httpClosed: true, socketsClosed: true, dedicatedBackendsClosed: true }));
  }
}));
await fs.writeFile(output, JSON.stringify({ version: 1, fixture: 'normal-editor-runtime',
  scope: 'isolated-runtime-process-windows-including-concurrent-background-work',
  physicalConnectionCoverage: '100ms-administrative-pg_stat_activity-sampling-lower-bound', profiles, operations, admissionPolls }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
completed = true;
