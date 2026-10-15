import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { Hocuspocus, type Document } from '@hocuspocus/server';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function until(predicate: () => boolean, label: string, deadline: number) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Protocol probe deadline: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Sync frames only: never retain authentication, awareness or other traffic. */
function describeFrame(raw: Uint8Array) {
  if (raw.byteLength > 4096) throw new Error('Synthetic sync frame exceeds probe budget.');
  try {
    const decoder = decoding.createDecoder(raw), documentName = decoding.readVarString(decoder);
    if (decoding.readVarUint(decoder) !== 0) return null;
    const subtype = decoding.readVarUint(decoder), payload = decoding.readVarUint8Array(decoder);
    if (![0, 1, 2].includes(subtype)) return null;
    const update = subtype === 0 ? null : Y.decodeUpdate(payload);
    return { documentName, subtype, bytes: raw.byteLength, frameSha256: createHash('sha256').update(raw).digest('hex'),
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      stateVector: subtype === 0 ? [...Y.decodeStateVector(payload)] : null,
      structs: update?.structs.map(item => ({ client: item.id.client, clock: item.id.clock, length: item.length })) ?? [],
      deletes: update ? [...update.ds.clients].map(([client, ranges]) => ({ client, ranges: ranges.map(range => ({ clock: range.clock, length: range.len })) })) : [],
      syncFrameBase64: Buffer.from(raw).toString('base64') };
  } catch (error) {
    // Auth/connection-level frames need not have the document Sync envelope.
    if (raw[0] === 9) return null;
    throw error;
  }
}

async function runScenario(dropA: boolean, evidenceRoot: string) {
  const label = dropA ? 'simulated-A-transport-loss' : 'control-A-applied';
  const deadline = Date.now() + 15_000, name = `protocol-${label}`;
  const frames: object[] = [], snapshots: object[] = [];
  let stage = 'initial', sequence = 0, connectionNumber = 0, clientClosed = false;
  let aHash: string | undefined, bHash: string | undefined, bQueued = false, aDropped = false, fullSyncGated = false, fullSyncApplied = false;
  const upgrade = deferred(), fullSync = deferred();
  const rawSockets = new Set<import('node:net').Socket>(), serverSockets = new Set<WebSocket>();
  const rooms = new Set<Document>(), clientSockets: WebSocket[] = [];
  const seed = new Y.Doc(); seed.getText('content').insert(0, 'base');
  let durableBytes = Y.encodeStateAsUpdate(seed);
  const local = new Y.Doc();
  const observe = (direction: string, raw: Uint8Array) => {
    const frame = describeFrame(raw);
    if (frame) {
      if (frames.length >= 96) throw new Error('Synthetic frame count exceeds probe budget.');
      const item = { sequence: ++sequence, stage, direction, ...frame }; frames.push(item); return item;
    }
    return null;
  };
  const snapshot = (point: string) => {
    const room = hocuspocus.documents.get(name);
    assert.ok(room, 'actual Hocuspocus document exists');
    const value = { point, fullSyncApplied, roomText: room.getText('content').toString(), localText: local.getText('content').toString(),
      roomPendingStructs: Boolean(room.store.pendingStructs), roomPendingDs: Boolean(room.store.pendingDs),
      missing: room.store.pendingStructs ? [...room.store.pendingStructs.missing] : [],
      localPendingStructs: Boolean(local.store.pendingStructs), localPendingDs: Boolean(local.store.pendingDs),
      roomVector: [...Y.decodeStateVector(Y.encodeStateVector(room))], localVector: [...Y.decodeStateVector(Y.encodeStateVector(local))],
      roomUpdateSha256: createHash('sha256').update(Y.encodeStateAsUpdate(room)).digest('hex'),
      localUpdateSha256: createHash('sha256').update(Y.encodeStateAsUpdate(local)).digest('hex') };
    snapshots.push(value); return value;
  };
  const hocuspocus = new Hocuspocus({ debounce: 20, maxDebounce: 40, unloadImmediately: true,
    async onLoadDocument({ document }) { rooms.add(document); Y.applyUpdate(document, durableBytes); },
    // Pure fixture memory only. Accepted control A must survive a normal room reload.
    async onStoreDocument({ document }) { durableBytes = Y.encodeStateAsUpdate(document); },
    async beforeHandleMessage({ update, connection }) {
      const frame = observe('server-before-handle', update);
      if (dropA && stage === 'send-A' && frame?.subtype === 2 && frame.payloadSha256 === aHash) {
        aDropped = true;
        // Explicit simulated transport loss. This is not a PrincipalBusy or authorization fixture.
        connection.webSocket.close(1013, 'Synthetic A transport loss before apply');
        throw new Error('Synthetic A transport loss before apply');
      }
    },
    async beforeSync({ type }) {
      if (stage === 'reconnecting' && type === 1 && !fullSyncGated) {
        fullSyncGated = true; await fullSync.promise;
      }
    },
    async afterHandleMessage({ update }) {
      const frame = describeFrame(update);
      if (stage === 'reconnecting' && frame?.subtype === 1) fullSyncApplied = true;
      if (stage === 'reconnecting' && frame?.subtype === 2 && frame.payloadSha256 === bHash) snapshot('B-applied-before-full-SyncStep2');
    },
  });
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('connection', socket => { rawSockets.add(socket); socket.once('close', () => rawSockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    const number = ++connectionNumber;
    void (async () => {
      if (number === 2) await upgrade.promise;
      if (socket.destroyed) return;
      wss.handleUpgrade(request, socket, head, ws => {
        serverSockets.add(ws); ws.once('close', () => serverSockets.delete(ws));
        const connection = hocuspocus.handleConnection(ws, new Request(`http://127.0.0.1${request.url ?? '/'}`, { headers: { host: '127.0.0.1' } }));
        ws.on('message', (data: RawData) => {
          const bytes = new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data as ArrayBuffer);
          observe('server-wire-receive', bytes); connection.handleMessage(bytes);
        });
        ws.on('close', (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
      });
    })().catch(error => { socket.destroy(); console.error('Owned upgrade fixture failed', error); });
  });
  class ObservedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); clientSockets.push(this); }
    override send(data: Parameters<WebSocket['send']>[0], callback?: (error?: Error) => void): void;
    override send(data: Parameters<WebSocket['send']>[0], options: Parameters<WebSocket['send']>[1], callback?: (error?: Error) => void): void;
    override send(data: Parameters<WebSocket['send']>[0], optionsOrCallback?: Parameters<WebSocket['send']>[1] | ((error?: Error) => void), callback?: (error?: Error) => void) {
      if (data instanceof Uint8Array) observe('client-wire-send', data);
      if (typeof optionsOrCallback === 'function' || optionsOrCallback === undefined) return super.send(data, optionsOrCallback);
      return super.send(data, optionsOrCallback, callback);
    }
  }
  let socket: HocuspocusProviderWebsocket | undefined, provider: HocuspocusProvider | undefined;
  let outcome: object = { label, completed: false };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${address.port}`, autoConnect: false,
      WebSocketPolyfill: ObservedWebSocket, delay: 50, initialDelay: 0, minDelay: 50, maxDelay: 50, jitter: false });
    provider = new HocuspocusProvider({ websocketProvider: socket, name, document: local, flushDelay: 75,
      onClose() { clientClosed = true; },
      onOutgoingMessage({ message }) {
        // Generic Sync replies carry their encoder on MessageSender; real wire observation below still captures them.
        if (message.type !== 0) return;
        const frame = observe('provider-outgoing-before-socket-queue', message.toUint8Array());
        if (frame?.subtype !== 2) return;
        if (stage === 'send-A') aHash = frame.payloadSha256;
        if (stage === 'offline-B') { bHash = frame.payloadSha256; bQueued = true; }
      } });
    provider.attach();
    let connectError: unknown;
    void socket.connect().catch(error => { connectError = error; });
    await until(() => {
      if (connectError) throw connectError;
      return Boolean(provider?.synced) && hocuspocus.documents.get(name)?.getText('content').toString() === 'base';
    }, 'initial full sync', deadline);
    stage = 'send-A'; local.getText('content').insert(4, 'A');
    if (dropA) await until(() => aDropped && clientClosed, 'A transport loss and real client close', deadline);
    else {
      await until(() => hocuspocus.documents.get(name)?.getText('content').toString() === 'baseA', 'control A accepted', deadline);
      for (const peer of serverSockets) peer.close(1013, 'Synthetic control reconnect after accepted A');
      await until(() => clientClosed, 'control actual socket close', deadline);
    }
    stage = 'offline-B'; local.getText('content').insert(5, 'B');
    await until(() => bQueued && connectionNumber === 2, 'actual 75ms offline B batch and blocked second upgrade', deadline);
    assert.equal(clientSockets.at(-1)?.readyState, WebSocket.CONNECTING, 'B queued while actual reconnect upgrade is held');
    stage = 'reconnecting'; upgrade.resolve();
    await until(() => fullSyncGated, 'genuine client full SyncStep2 gate', deadline);
    const before = snapshot('full-SyncStep2-gated');
    const wire = frames as Array<{ direction: string; stage: string; subtype: number; payloadSha256: string; sequence: number }>;
    const bFrame = wire.find(frame => frame.direction === 'server-wire-receive' && frame.stage === 'reconnecting' && frame.subtype === 2 && frame.payloadSha256 === bHash);
    const baseline = wire.find(frame => frame.direction === 'server-wire-receive' && frame.stage === 'reconnecting' && frame.subtype === 1);
    assert.ok(bFrame && baseline, 'actual B frame and actual full SyncStep2 observed, never reordered');
    assert.ok(bFrame.sequence < baseline.sequence, 'hypothesis: queued B naturally precedes client full SyncStep2');
    assert.equal(before.localPendingStructs || before.localPendingDs, false);
    assert.equal(before.roomPendingStructs || before.roomPendingDs, dropA, 'only missing A may leave the room waiting for B dependencies');
    fullSync.resolve();
    await until(() => {
      const room = hocuspocus.documents.get(name);
      return fullSyncApplied && room?.getText('content').toString() === 'baseAB' && !room.store.pendingStructs && !room.store.pendingDs;
    }, 'full SyncStep2 repairs and converges', deadline);
    const after = snapshot('full-SyncStep2-applied');
    assert.equal(after.roomUpdateSha256, after.localUpdateSha256, 'same retained Y.Doc full state converges exactly');
    outcome = { label, completed: true, dropAIsSimulatedTransportLossNotPrincipalBusy: true,
      bNaturallyPrecededFullSync: true, before, after };
    console.log(JSON.stringify(outcome));
  } catch (error) {
    outcome = { label, completed: false, reason: error instanceof Error ? error.message : String(error),
      interpretation: 'A negative hypothesis probe is preserved; no frame routing or assertions are altered.' };
    throw error;
  } finally {
    stage = 'cleanup'; upgrade.resolve(); fullSync.resolve();
    provider?.destroy(); socket?.destroy();
    for (const peer of serverSockets) peer.terminate();
    for (const peer of clientSockets) if (peer.readyState !== WebSocket.CLOSED) peer.terminate();
    for (const raw of rawSockets) raw.destroy();
    let wsClosed = false, httpClosed = false;
    wss.close(() => { wsClosed = true; }); server.close(() => { httpClosed = true; });
    try { await until(() => wsClosed && httpClosed && serverSockets.size === 0 && rawSockets.size === 0, 'exact owned WS/HTTP cleanup', Date.now() + 3000); }
    finally {
      for (const room of rooms) if (!room.isDestroyed) room.destroy();
      local.destroy(); seed.destroy();
      await writeFile(`${evidenceRoot}/${label}.json`, JSON.stringify({ outcome, frames, snapshots,
        cleanup: { wsClosed, httpClosed, liveServerSockets: serverSockets.size, liveRawSockets: rawSockets.size } }, null, 2), { mode: 0o600, flag: 'wx' });
    }
  }
}

async function main() {
  const evidenceRoot = process.argv[2]; assert.ok(evidenceRoot, 'Pass a fresh private evidence directory.');
  await mkdir(evidenceRoot, { mode: 0o700 });
  await runScenario(false, evidenceRoot);
  await runScenario(true, evidenceRoot);
  console.log('Pure provider protocol: control and simulated A-loss mechanism observed; original browser cause remains unproven.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
