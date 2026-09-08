import assert from 'node:assert/strict';
import { DocxSaveSession, type DocxSaveState } from '../app/lib/office/docx-save-session';
import { createDocxClient, DocxClientError, type DocxIdentity, type DocxSaveClient, type DocxSaveRequest } from '../app/lib/office/docx-client';
import { createDocxRecoveryStore, docxRecoveryKey, type DocxRecoveryRecord, type DocxRecoveryStore } from '../app/lib/office/docx-recovery';

type Model = { text: string; original?: Uint8Array };
const identity: DocxIdentity = { accountId: 'alice', workspaceId: 'team', path: 'report.docx', lineageId: 'lineage-1', sessionId: 'editor-session-0001' };
const baseline = { sha256: 'original-hash', revisionId: 'revision-1' };
const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const pause = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition reached before timeout'); await pause(1); }
}

class MemoryRecovery implements DocxRecoveryStore<Model> {
  records = new Map<string, DocxRecoveryRecord<Model>>();
  async load(scope: DocxIdentity) {
    return [...this.records.values()].reverse().find((record) => docxRecoveryKey(record.identity) === docxRecoveryKey(scope) && (record.generation > record.savedGeneration || record.pendingRequest)) ?? null;
  }
  async save(record: DocxRecoveryRecord<Model>) {
    this.records.set(`${docxRecoveryKey(record.identity)}:${record.identity.sessionId}`, structuredClone(record));
  }
}

function setup(overrides: {
  client?: Partial<DocxSaveClient>;
  serialize?: (model: Model) => Promise<Uint8Array>;
  recovery?: DocxRecoveryStore<Model>;
  identity?: DocxIdentity;
  baseline?: typeof baseline;
  debounceMs?: number;
  maxWaitMs?: number;
  renewMs?: number;
} = {}) {
  const requests: DocxSaveRequest[] = [];
  const states: DocxSaveState[] = [];
  const recovery = overrides.recovery ?? new MemoryRecovery();
  const client: DocxSaveClient = {
    async acquire() { return { id: 'lease-1', expiresAt: Date.now() + 10000 }; },
    async renew(_path, _session, id) { return { id, expiresAt: Date.now() + 10000 }; },
    async release() {},
    async write(request) {
      requests.push(structuredClone(request));
      return { sha256: `hash-${requests.length}`, revisionId: `revision-${requests.length + 1}` };
    },
    ...overrides.client,
  };
  const session = new DocxSaveSession<Model>({
    identity: overrides.identity ?? identity, baseline: overrides.baseline ?? baseline, originalBytes: bytes('original zip'), initialDocument: { text: 'original' },
    serialize: overrides.serialize ?? (async (model) => bytes(model.text)), client, recovery,
    onState: (state) => states.push(state), debounceMs: overrides.debounceMs ?? 5000,
    maxWaitMs: overrides.maxWaitMs ?? 10000, renewMs: overrides.renewMs ?? 5000,
  });
  return { session, requests, states, recovery };
}

async function snapshotsAndSingleFlight() {
  const exportGate = deferred<Uint8Array>();
  const uploadGate = deferred<{ sha256: string; revisionId: string }>();
  const seen: string[] = [];
  const requests: DocxSaveRequest[] = [];
  const { session, states } = setup({
    serialize: async (model) => { seen.push(model.text); return seen.length === 1 ? exportGate.promise : bytes(model.text); },
    client: { write: async (request) => {
      requests.push(structuredClone(request));
      return requests.length === 1 ? uploadGate.promise : { sha256: 'second', revisionId: 'revision-3' };
    } },
  });
  await session.start();
  const model = { text: 'first' };
  session.change(model);
  model.text = 'mutated outside controller';
  assert.equal(session.getState().dirty, true);
  const flush = session.flush();
  const secondFlush = session.flush();
  await until(() => seen.length === 1);
  session.change({ text: 'second' });
  assert.deepEqual(seen, ['first']);
  exportGate.resolve(bytes('first'));
  await until(() => requests.length === 1);
  assert.equal(seen.length, 1, 'next generation not exported during first upload');
  uploadGate.resolve({ sha256: 'first', revisionId: 'revision-2' });
  await Promise.all([flush, secondFlush]);
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(requests[1].expectedSha256, 'first');
  assert.equal(requests[1].baseRevisionId, 'revision-2');
  assert.ok(states.some((state) => state.savedGeneration === 1 && state.generation === 2 && state.dirty));
  assert.equal(session.getState().pending, false);
  assert.equal(session.getBaseline().sha256, 'second');
  session.dispose();
}

async function lostResponseAndRecovery() {
  const recovery = new MemoryRecovery();
  const uploadGate = deferred<{ sha256: string; revisionId: string }>();
  const requests: DocxSaveRequest[] = [];
  let exports = 0;
  const first = setup({ recovery, serialize: async (model) => { exports++; return bytes(model.text); }, client: { write: async (request) => { requests.push(structuredClone(request)); return uploadGate.promise; } } });
  await first.session.start();
  first.session.change({ text: 'sent' });
  const attempt = first.session.flush();
  await until(() => requests.length === 1);
  first.session.change({ text: 'newer local draft' });
  uploadGate.reject(new Error('response lost'));
  await assert.rejects(attempt, /response lost/);
  assert.equal(first.session.getState().readOnly, true);
  const oldRecord = await first.session.getRecovery();
  assert.ok(oldRecord?.pendingRequest);
  assert.equal(oldRecord.document.text, 'newer local draft');
  first.session.dispose();

  const second = setup({
    identity: { ...identity, sessionId: 'editor-session-0002' }, recovery,
    serialize: async (model) => { exports++; return bytes(model.text); },
    client: { write: async (request) => {
      requests.push(structuredClone(request));
      return { sha256: `ack-${requests.length}`, revisionId: `revision-${requests.length + 1}` };
    } },
  });
  const record = await second.session.getRecovery();
  assert.ok(record);
  await second.session.restoreRecovery(record);
  assert.equal(second.session.getDocument().text, 'newer local draft');
  await second.session.start();
  await second.session.retry();
  assert.equal(exports, 2, 'lost response replay does not re-export acknowledged candidate');
  assert.equal(requests[1].idempotencyKey, requests[0].idempotencyKey);
  assert.deepEqual(requests[1].bytes, requests[0].bytes);
  assert.equal(requests[1].sessionId, identity.sessionId, 'replay keeps original session');
  assert.equal(requests[2].sessionId, 'editor-session-0002', 'new generation uses its own editor lease');
  assert.equal(requests[2].expectedSha256, 'ack-2');
  assert.equal(decode(requests[2].bytes), 'newer local draft');
  assert.ok([...recovery.records.values()].some((entry) => entry.identity.sessionId === identity.sessionId && entry.pendingRequest), 'new session never deletes original tab recovery');
  second.session.dispose();

  for (const alternate of [
    { ...identity, accountId: 'bob' }, { ...identity, workspaceId: 'other' },
    { ...identity, lineageId: 'replacement' }, { ...identity, path: 'renamed.docx' },
  ]) {
    const other = setup({ identity: alternate, recovery });
    assert.equal(await other.session.getRecovery(), null);
    await assert.rejects(other.session.restoreRecovery(oldRecord), /another document or account/);
    other.session.dispose();
  }
}

async function noAutomaticRebase() {
  const recovery = new MemoryRecovery();
  const old = setup({ recovery });
  await old.session.start();
  old.session.change({ text: 'old draft' });
  await until(() => recovery.records.size === 1);
  const record = await old.session.getRecovery();
  assert.ok(record);
  old.session.dispose();
  const current = setup({ baseline: { sha256: 'new-server-file', revisionId: 'revision-50' }, client: { write: async (request) => {
    assert.deepEqual([request.expectedSha256, request.baseRevisionId], ['original-hash', 'revision-1']);
    throw new DocxClientError('Document changed.', 'FILE_REVISION_CONFLICT', 409);
  } } });
  await current.session.restoreRecovery(record);
  await current.session.start();
  await assert.rejects(current.session.flush(), /Document changed/);
  assert.equal(current.session.getState().dirty, true);
  assert.equal(current.session.getState().readOnly, true);
  assert.equal(decode(await current.session.exportCopy()), 'old draft');
  current.session.dispose();
}

async function leaseExpiryAndDispose() {
  const renewal = deferred<{ id: string; expiresAt: number }>();
  let renewalStarted = false;
  const expired = setup({ renewMs: 5, client: {
    acquire: async () => ({ id: 'lease-1', expiresAt: Date.now() + 35 }),
    renew: async () => { renewalStarted = true; return renewal.promise; },
  } });
  await expired.session.start();
  await until(() => renewalStarted);
  await pause(45);
  assert.equal(expired.session.getState().readOnly, true);
  renewal.resolve({ id: 'lease-1', expiresAt: Date.now() + 10000 });
  await pause();
  assert.equal(expired.session.getState().readOnly, true, 'late renewal never resurrects expired lease');
  assert.throws(() => expired.session.change({ text: 'no' }), /expired/);
  expired.session.dispose();

  const exportGate = deferred<Uint8Array>();
  const closed = setup({ serialize: async () => exportGate.promise });
  await closed.session.start();
  closed.session.change({ text: 'local' });
  const flush = closed.session.flush();
  await pause();
  closed.session.dispose();
  const statesAtClose = closed.states.length;
  exportGate.resolve(bytes('local'));
  await assert.rejects(flush, /closed/);
  assert.equal(closed.requests.length, 0, 'dispose during export cannot upload');
  assert.equal(closed.states.length, statesAtClose, 'no stale callbacks after close');

  const upload = deferred<{ sha256: string; revisionId: string }>();
  let uploadStarted = false;
  const duringUpload = setup({ client: { write: async () => { uploadStarted = true; return upload.promise; } } });
  await duringUpload.session.start();
  duringUpload.session.change({ text: 'in flight' });
  const uploading = duringUpload.session.flush();
  await until(() => uploadStarted);
  duringUpload.session.dispose();
  const callbackCount = duringUpload.states.length;
  upload.resolve({ sha256: 'late', revisionId: 'revision-late' });
  await assert.rejects(uploading, /closed/);
  assert.equal(duringUpload.states.length, callbackCount);
  assert.equal(duringUpload.session.getBaseline().sha256, baseline.sha256, 'late upload cannot advance disposed session');

  const acquired = deferred<{ id: string; expiresAt: number }>();
  const released: string[] = [];
  const opening = setup({ client: { acquire: async () => acquired.promise, release: async (_path, _session, id) => { released.push(id); } } });
  const starting = opening.session.start();
  opening.session.dispose();
  acquired.resolve({ id: 'late-lease', expiresAt: Date.now() + 1000 });
  await starting;
  assert.deepEqual(released, ['late-lease'], 'lease acquired after disposal is released');
}

async function boundedRecoveryAndAutosave() {
  const diskGate = deferred<void>();
  const stored: DocxRecoveryRecord<Model>[] = [];
  const queued = setup({ recovery: {
    async load() { return null; },
    async save(record) { stored.push(structuredClone(record)); if (stored.length === 1) await diskGate.promise; },
  } });
  await queued.session.start();
  queued.session.change({ text: 'first' });
  await until(() => stored.length === 1);
  for (let i = 0; i < 100; i++) queued.session.change({ text: `edit-${i}` });
  assert.equal(stored.length, 1);
  diskGate.resolve();
  await until(() => stored.length === 2);
  assert.equal(stored[1].document.text, 'edit-99');
  assert.equal(queued.requests.length, 0, 'model persisted before debounce export');
  queued.session.dispose();

  const automatic = setup({ debounceMs: 20, maxWaitMs: 50 });
  await automatic.session.start();
  for (let i = 0; i < 12; i++) { automatic.session.change({ text: `typing-${i}` }); await pause(7); }
  assert.ok(automatic.requests.length >= 1, 'maximum wait saves during continuous typing');
  assert.ok(automatic.requests.length <= 2, 'typing does not produce one upload per change');
  await automatic.session.flush();
  assert.equal(decode(automatic.requests.at(-1)!.bytes), 'typing-11');
  automatic.session.dispose();

  let fail = true;
  const failedDisk = setup({ recovery: { async load() { return null; }, async save() { if (fail) throw new Error('quota exhausted'); } } });
  await failedDisk.session.start();
  failedDisk.session.change({ text: 'must survive' });
  await assert.rejects(failedDisk.session.flush(), /quota exhausted/);
  assert.equal(failedDisk.requests.length, 0, 'uncertain request never published without durable request storage');
  assert.equal(failedDisk.session.getState().pending, true);
  assert.match(failedDisk.session.getState().recoveryError!.message, /quota/);
  fail = false;
  await failedDisk.session.retry();
  assert.equal(failedDisk.requests.length, 1);
  assert.equal(failedDisk.session.getState().pending, false);
  failedDisk.session.dispose();
}

async function browserTransport() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const headers = { 'X-Workspace-Id': identity.workspaceId };
  const client = createDocxClient({ workspaceId: identity.workspaceId, workspaceHeaders: headers, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const data = String(url).includes('/read?') ? {
      content: 'base64:eGlw', stats: { sha256: baseline.sha256 }, revision: { id: baseline.revisionId },
      collaboration: { lineageId: identity.lineageId }, viewerUserId: identity.accountId, workspaceId: identity.workspaceId,
    } : { lock: { id: 'lease', expiresAt: Date.now() + 120000 }, stats: { sha256: 'saved' }, revision: { id: 'rev-2' } };
    return new Response(JSON.stringify({ success: true, data }));
  } });
  headers['X-Workspace-Id'] = 'changed-selection';
  assert.equal(decode((await client.read('a b.docx')).bytes), 'xip');
  await client.acquire(identity.path, identity.sessionId, baseline.revisionId, 120000);
  await client.renew(identity.path, identity.sessionId, 'lease', 120000);
  await client.write({ path: identity.path, sessionId: identity.sessionId, lockId: 'lease', expectedSha256: baseline.sha256, baseRevisionId: baseline.revisionId, idempotencyKey: 'retry-key', bytes: bytes('payload') });
  await client.release(identity.path, identity.sessionId, 'lease');
  await client.versions(identity.path);
  assert.ok(calls.every((call) => new Headers(call.init.headers).get('X-Workspace-Id') === identity.workspaceId));
  assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'POST', 'PATCH', 'POST', 'DELETE', 'GET']);
  assert.equal(JSON.parse(String(calls[3].init.body)).content, 'base64:cGF5bG9hZA==');
  await assert.rejects(createDocxRecoveryStore().load(identity), /unavailable/, 'missing IndexedDB is visible, never in-memory pretend persistence');
}

async function preserveDraftBeforeReload() {
  const gate = deferred<void>();
  const records: DocxRecoveryRecord<Model>[] = [];
  const retained = setup({ recovery: {
    async load() { return records.at(-1) ?? null; },
    async save(record) { records.push(structuredClone(record)); if (records.length === 1) await gate.promise; },
  } });
  await retained.session.start();
  retained.session.change({ text: 'before reload' });
  await until(() => records.length === 1);
  let preserved = false;
  const preserving = retained.session.preserveDraft().then(() => { preserved = true; });
  retained.session.change({ text: 'edit while storage is pending' });
  assert.equal(preserved, false);
  retained.session.dispose();
  const callbacks = retained.states.length;
  gate.resolve();
  await preserving;
  assert.equal(records.at(-1)?.document.text, 'edit while storage is pending');
  assert.equal(records.at(-1)?.generation, 2);
  assert.equal(records.at(-1)?.savedGeneration, 0);
  assert.equal(retained.requests.length, 0, 'preserve does not export or publish');
  assert.equal(retained.states.length, callbacks, 'durable recovery finishes without disposed UI callbacks');
  assert.equal(retained.session.getState().dirty, true);
  await assert.rejects(retained.session.preserveDraft(), /closed/);

  const firstDisk = deferred<void>();
  const lastDisk = deferred<void>();
  const interleavedRecords: DocxRecoveryRecord<Model>[] = [];
  const interleaved: ReturnType<typeof setup> = setup({ recovery: {
    async load() { return null; },
    async save(record) {
      interleavedRecords.push(structuredClone(record));
      if (interleavedRecords.length === 1) {
        await firstDisk.promise;
        queueMicrotask(() => queueMicrotask(() => interleaved.session.change({ text: 'completion boundary edit' })));
      } else if (record.document.text === 'completion boundary edit') await lastDisk.promise;
    },
  } });
  await interleaved.session.start();
  interleaved.session.change({ text: 'first model' });
  await until(() => interleavedRecords.length === 1);
  let drainFinished = false;
  const draining = interleaved.session.preserveDraft().then(() => { drainFinished = true; });
  firstDisk.resolve();
  await until(() => interleavedRecords.some((record) => record.document.text === 'completion boundary edit'));
  assert.equal(drainFinished, false, 'preserve waits for the write queued at the completion boundary');
  lastDisk.resolve();
  await draining;
  interleaved.session.dispose();
}

async function staleLeaseRecoveryWithUnchangedServer() {
  const recovery = new MemoryRecovery();
  const initial = setup({ recovery, client: { write: async () => { throw new Error('connection lost before any server response'); } } });
  await initial.session.start();
  initial.session.change({ text: 'valuable draft' });
  await assert.rejects(initial.session.flush(), /connection lost/);
  await initial.session.preserveDraft();
  const record = await initial.session.getRecovery();
  assert.ok(record?.pendingRequest);
  const originalRequest = structuredClone(record.pendingRequest);
  initial.session.dispose();

  let canonical = 'original zip';
  const requests: DocxSaveRequest[] = [];
  const reopened = setup({ recovery, identity: { ...identity, sessionId: 'editor-session-new-lease' }, client: {
    acquire: async () => ({ id: 'new-lease', expiresAt: Date.now() + 10000 }),
    write: async (request) => {
      requests.push(structuredClone(request));
      assert.equal(canonical, 'original zip', 'the server file is unchanged');
      if (request.lockId !== 'new-lease') throw new DocxClientError('The original lease is expired.', 'FILE_LOCK_STALE', 409);
      canonical = decode(request.bytes);
      return { sha256: 'new', revisionId: 'new-revision' };
    },
  } });
  await reopened.session.restoreRecovery(record);
  await reopened.session.start();
  await assert.rejects(reopened.session.retry(), /original lease is expired/);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], originalRequest, 'expired old request never borrows the replacement lease');
  assert.equal(canonical, 'original zip');
  assert.deepEqual(reopened.session.getBaseline(), baseline, 'unchanged baseline still requires its original fenced request');
  assert.equal(reopened.session.getState().dirty, true);
  assert.equal(reopened.session.getState().readOnly, true);
  assert.equal(decode(await reopened.session.exportCopy()), 'valuable draft');
  await reopened.session.preserveDraft();
  const again = await reopened.session.getRecovery();
  assert.deepEqual(again?.pendingRequest, originalRequest);
  reopened.session.dispose();
}

async function main() {
  await snapshotsAndSingleFlight();
  await lostResponseAndRecovery();
  await noAutomaticRebase();
  await leaseExpiryAndDispose();
  await boundedRecoveryAndAutosave();
  await browserTransport();
  await preserveDraftBeforeReload();
  await staleLeaseRecoveryWithUnchangedServer();
  console.log('DOCX autosave: snapshots, single-flight, exact retries, identity recovery, lease expiry, bounded persistence, transport passed.');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
