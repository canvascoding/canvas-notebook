import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { expect, test, type APIResponse, type BrowserContext } from '@playwright/test';
import { Client } from 'pg';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest, type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const execute = promisify(execFile);
const enabled = process.env.COLLABORATION_LIFECYCLE_E2E === '1';
const baseURL = process.env.BASE_URL || '';
type Room = { document: Y.Doc; provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket;
  session: { documentName: string; token: string; lifecycleGeneration: number }; close: () => void };
type OperationResult = { success?: boolean; code?: string; operation?: { batchId: string; status: string; errorCode: string | null;
  kind: string; selections: Array<{ sourcePath: string }> };
  trashEntries?: Array<{ id: string; originalPath: string }> };

function managedDatabaseUrl(): string {
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL || ''); } catch { throw new Error('Managed lifecycle E2E needs private PostgreSQL configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.port !== '55433' || url.pathname !== '/canvas_notebook'
    || !['http://127.0.0.1:3100', 'http://localhost:3100'].includes(baseURL)
    || process.env.E2E_EXTERNAL_SERVER !== '1') throw new Error('Lifecycle E2E only accepts the existing managed loopback stack.');
  return url.href;
}

async function openRoom(context: BrowserContext, workspaceId: string, filePath: string): Promise<Room> {
  const response = await context.request.post('/api/files/collaboration/session', {
    headers: { 'x-canvas-workspace-id': workspaceId }, data: { path: filePath, representation: 'plain_text' },
  });
  expect(response.ok(), `Collaboration session for ${filePath}`).toBeTruthy();
  const session = await response.json();
  expect(session.representation).toBe('plain_text');
  const document = new Y.Doc();
  const cookies = (await context.cookies(baseURL)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  class AuthenticatedSocket extends WebSocket {
    constructor(address: string) { super(address, { origin: baseURL, headers: { Cookie: cookies } }); }
  }
  const socket = new HocuspocusProviderWebsocket({ url: new URL(session.websocketUrl, baseURL).href.replace(/^http/u, 'ws'),
    preserveTrailingSlash: true, WebSocketPolyfill: AuthenticatedSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: session.documentName, token: session.token, document });
  let closed = false;
  const close = () => { if (closed) return; closed = true; provider.destroy(); socket.destroy(); document.destroy(); };
  try {
    provider.attach(); await expect.poll(() => provider.isSynced, { timeout: 30_000 }).toBe(true);
    // Socket sync does not certify that onLoad's atomic file projection has
    // finished. Start snapshot-sensitive actions only after the exact real
    // document checkpoint is finalized, preserving the lifecycle Busy checks.
    await expect.poll(async () => {
      const stateVector = Buffer.from(Y.encodeStateVector(document)).toString('base64');
      const stateProof = collaborationStateProof(document, Y);
      const checkpoint = await context.request.post('/api/files/collaboration/checkpoint', {
        headers: { 'x-canvas-workspace-id': workspaceId },
        data: { token: session.token, stateVector, stateProof },
      });
      if (!checkpoint.ok()) return false;
      const receipt = await checkpoint.json();
      return receipt.documentId === session.documentId
        && receipt.lifecycleGeneration === session.lifecycleGeneration
        && receipt.stateVector === stateVector && receipt.stateProof === stateProof
        && receipt.documentSequence === receipt.checkpointSequence
        && receipt.projectionFinalized === true && receipt.schemaValidated === true;
    }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
  }
  catch (error) { close(); throw error; }
  return { document, provider, socket, session, close };
}

/** Actual admission service in a react-server process, using the same managed PG and exclusively this test's workspace. */
async function admissionFixture(action: 'reserve' | 'cancel', request: CollaborationAdmissionRequest, revision?: number) {
  const source = `
    const { createCollaborationAdmissionService } = await import('./app/lib/collaboration/room-admission.ts');
    const { openDb, closeDatabaseConnections } = await import('./app/lib/db/index.ts');
    const input = JSON.parse(process.argv[1]);
    try {
      const service = createCollaborationAdmissionService({ openConnection: openDb });
      const result = input.action === 'reserve' ? await service.reserve(input.request) : await service.cancel(input.request, input.revision);
      console.log('LIFECYCLE_FIXTURE:' + JSON.stringify({ requestId: result.requestId, status: result.status, revision: result.revision }));
    } finally { await closeDatabaseConnections(); }
  `;
  const output = await execute(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', source,
    JSON.stringify({ action, request, revision })], { cwd: process.cwd(), env: process.env, timeout: 30_000 });
  const record = output.stdout.split('\n').find(line => line.startsWith('LIFECYCLE_FIXTURE:'));
  if (!record) throw new Error('Owned admission fixture returned no durable result.');
  return JSON.parse(record.slice('LIFECYCLE_FIXTURE:'.length)) as { requestId: string; status: string; revision: number };
}

/** Verify the production durable receipt and actual advisory-lock release, rather than only the cleared token. */
async function confirmOwnerReleased(workspaceId: string, documentId: string) {
  const source = `
    const { openDb, closeDatabaseConnections } = await import('./app/lib/db/index.ts');
    const { lockIdentity } = await import('./app/lib/collaboration/room-owner.ts');
    const { validateCollaborationRoomReleaseReceipt } = await import('./app/lib/collaboration/room-owner-release.ts');
    const input = JSON.parse(process.argv[1]);
    let database;
    try {
      database = await openDb();
      const lock = lockIdentity(input.documentId);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = await database.get('SELECT * FROM collaboration_yjs_states WHERE workspace_id=$1 AND document_id=$2', [input.workspaceId, input.documentId]);
        const receipt = state && await database.get('SELECT * FROM collaboration_room_release_receipts WHERE workspace_id=$1 AND document_id=$2 AND owner_epoch=$3 ORDER BY created_at DESC LIMIT 1', [input.workspaceId, input.documentId, state.room_owner_epoch]);
        const holder = await database.get("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND mode='ExclusiveLock' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1) AS held", [lock.high, lock.low]);
        if (state && receipt && holder?.held === false) {
          validateCollaborationRoomReleaseReceipt(state, receipt);
          console.log('OWNER_RELEASED:verified');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
      console.log('OWNER_RELEASE_CHECK:' + JSON.stringify({ code, name: error instanceof Error ? error.name : 'Error' }));
      process.exitCode = 1;
    } finally { await database?.close(); await closeDatabaseConnections(); }
  `;
  const output = await execute(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', source,
    JSON.stringify({ workspaceId, documentId })], { cwd: process.cwd(), env: process.env, timeout: 25_000 });
  expect(output.stdout.split('\n')).toContain('OWNER_RELEASED:verified');
}

test.describe('managed production owner file lifecycle', () => {
  test.skip(!enabled, 'Explicit managed lifecycle E2E flag is required.');
  test('opposite cross-workspace copies acquire the same canonical kernel order', async ({ browser }) => {
    test.setTimeout(90_000);
    managedDatabaseUrl();
    const context = await createAuthenticatedContext(browser);
    const workspaces: string[] = [];
    try {
      for (const label of ['left', 'right']) {
        const created = await context.request.post('/api/workspaces', {
          data: { type: 'personal', name: `E2E lifecycle opposite-copy ${label} ${randomUUID()}` },
        });
        expect(created.ok()).toBeTruthy();
        const workspaceId = (await created.json()).workspace.id as string; workspaces.push(workspaceId);
        const directory = await context.request.post('/api/files/create', {
          headers: { 'x-canvas-workspace-id': workspaceId }, data: { path: 'destination', type: 'directory' },
        });
        expect(directory.ok()).toBeTruthy();
        await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath: `${label}.txt`,
          mimeType: 'text/plain', content: `${label} physical bytes\n` });
      }
      const [leftToRight, rightToLeft] = await Promise.all([
        context.request.post('/api/files/copy', { timeout: 15_000, data: {
          sourceWorkspaceId: workspaces[0], targetWorkspaceId: workspaces[1], sources: ['left.txt'], destDir: 'destination',
        } }),
        context.request.post('/api/files/copy', { timeout: 15_000, data: {
          sourceWorkspaceId: workspaces[1], targetWorkspaceId: workspaces[0], sources: ['right.txt'], destDir: 'destination',
        } }),
      ]);
      for (const response of [leftToRight, rightToLeft]) {
        expect(response.ok()).toBeTruthy();
        const result = await response.json(); expect(result.failed).toEqual([]); expect(result.copied).toHaveLength(1);
      }
      const copiedLeft = await context.request.get('/api/files/download?path=destination%2Fleft.txt', {
        headers: { 'x-canvas-workspace-id': workspaces[1] },
      });
      const copiedRight = await context.request.get('/api/files/download?path=destination%2Fright.txt', {
        headers: { 'x-canvas-workspace-id': workspaces[0] },
      });
      expect(copiedLeft.ok()).toBeTruthy(); expect(await copiedLeft.text()).toBe('left physical bytes\n');
      expect(copiedRight.ok()).toBeTruthy(); expect(await copiedRight.text()).toBe('right physical bytes\n');
    } finally {
      for (const workspaceId of workspaces) {
        const cleanup = await context.request.delete(`/api/workspaces/${workspaceId}`); expect(cleanup.ok()).toBeTruthy();
      }
      await context.close();
    }
  });
  test('blocks open/pending documents before physical actions, preserves the other room, and permits closed file actions', async ({ browser }, info) => {
    test.setTimeout(240_000);
    const database = new Client({ connectionString: managedDatabaseUrl(), application_name: 'canvas-owned-lifecycle-e2e', connectionTimeoutMillis: 3_000 });
    await database.connect();
    const context = await createAuthenticatedContext(browser);
    const rooms: Room[] = [];
    let workspaceId: string | undefined;
    let pending: { request: CollaborationAdmissionRequest; revision: number } | undefined;
    try {
      const identity = await context.request.get('/api/auth/get-session');
      expect(identity.ok()).toBeTruthy();
      const userId = (await identity.json()).user.id as string;
      const workspace = await context.request.post('/api/workspaces', { data: { type: 'personal', name: `E2E lifecycle ${randomUUID()}` } });
      expect(workspace.ok()).toBeTruthy();
      workspaceId = (await workspace.json()).workspace.id;
      expect(workspaceId).toBeTruthy();
      const headers = { 'x-canvas-workspace-id': workspaceId! };
      const upload = (filePath: string, content: string) => uploadWorkspaceTextFile({ request: context.request, workspaceId: workspaceId!, filePath, content, mimeType: 'text/plain' });
      const mkdir = async (filePath: string) => {
        const response = await context.request.post('/api/files/create', { headers, data: { path: filePath, type: 'directory' } });
        expect(response.ok(), `Create ${filePath}`).toBeTruthy();
      };
      // Download uses the physical stream; the read endpoint may substitute the durable collaboration snapshot.
      const physicalResponse = async (filePath: string) => {
        for (let attempt = 0; ; attempt++) {
          const response = await context.request.get(`/api/files/download?path=${encodeURIComponent(filePath)}`, { headers });
          if (response.status() !== 429 || attempt >= 2) return response;
          // This suite intentionally checks more physical snapshots than the
          // production 30/minute export budget. Respect its actual retry fence;
          // a rate-limit response is never evidence of bytes or absence.
          const retryAfter = Number(response.headers()['retry-after']);
          expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60).toBeTruthy();
          expect(await response.json()).toMatchObject({ success: false, error: 'Too many requests' });
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 100));
        }
      };
      const disk = async (filePath: string) => {
        const response = await physicalResponse(filePath);
        expect(response.ok(), `Physical bytes ${filePath}; HTTP ${response.status()}`).toBeTruthy();
        return response.text();
      };
      const absent = async (filePath: string) => {
        const response = await physicalResponse(filePath);
        expect(response.status(), `Physical absence ${filePath}`).toBe(404);
      };
      const row = async (documentId: string) => (await database.query(`SELECT document_id,organization_id,path,status,lifecycle_generation,
        document_sequence,room_owner_epoch,room_owner_token FROM collaboration_yjs_states WHERE workspace_id=$1 AND document_id=$2`,
      [workspaceId, documentId])).rows[0];
      const operation = async (response: APIResponse, expected: 'applied' | 'blocked') => {
        const result = await response.json() as OperationResult;
        const knownCodes = ['COLLABORATION_FILE_LIFECYCLE_BUSY', 'PREVIEW_STALE', 'PREVIEW_UNREADABLE', 'PREVIEW_BLOCKED',
          'WORKSPACE_OPERATION_FAILED', 'BATCH_AUDIT_FAILED', 'WORKSPACE_FILE_CONFLICT', 'FILE_EXISTS', 'SOURCE_CHANGED',
          'TARGET_CHANGED', 'ADMISSION_BUSY', 'PERMISSION_DENIED', 'FORBIDDEN'];
        const diagnostic = JSON.stringify({ httpStatus: response.status(),
          code: result.code === undefined ? null : knownCodes.includes(result.code) ? result.code : 'unrecognized' });
        if (response.status() === 202) {
          expect(result.operation?.batchId).toBeTruthy();
          let terminal!: { status: string; errorCode: string | null; trashEntryIds: string[] };
          await expect.poll(async () => {
            const current = await context.request.get(`/api/files/operation-reviews/batches/${result.operation!.batchId}`, { headers });
            expect(current.ok()).toBeTruthy(); terminal = (await current.json()).batch;
            return ['queued', 'applying'].includes(terminal.status) ? 'pending' : 'terminal';
          }, { timeout: 45_000 }).toBe('terminal');
          expect(terminal.status).toBe(expected === 'applied' ? 'applied' : 'failed');
          if (expected === 'blocked') expect(terminal.errorCode).toBe('COLLABORATION_FILE_LIFECYCLE_BUSY');
          if (expected === 'applied' && result.operation!.kind === 'delete') {
            expect(terminal.trashEntryIds).toHaveLength(result.operation!.selections.length);
            result.trashEntries = terminal.trashEntryIds.map((id, index) => ({ id, originalPath: result.operation!.selections[index].sourcePath }));
          }
        } else if (expected === 'blocked') {
          expect(response.status(), diagnostic).toBe(409);
          expect(result.code, diagnostic).toBe('COLLABORATION_FILE_LIFECYCLE_BUSY');
        } else { expect(response.ok(), diagnostic).toBeTruthy(); expect(result.operation?.status, diagnostic).toBe('applied'); }
        return result;
      };
      await mkdir('source'); await mkdir('copies'); await mkdir('copy-source');
      const original = 'Owned original, with exact physical bytes.\n';
      await upload('source/owned.txt', original);
      await upload('copies/target.txt', 'Independent sentinel.\n');
      await upload('copy-source/neighbor.txt', 'Closed independent copy.\n');
      await upload('copy-source/target.txt', 'Collision-renamed copy.\n');
      const target = await openRoom(context, workspaceId!, 'source/owned.txt'); rooms.push(target);
      const sentinel = await openRoom(context, workspaceId!, 'copies/target.txt'); rooms.push(sentinel);
      await expect.poll(async () => Boolean((await row(target.session.documentName))?.room_owner_token)).toBe(true);
      expect(Number((await row(target.session.documentName)).room_owner_epoch)).toBeGreaterThan(0);
      let savedSequence = Number((await row(sentinel.session.documentName)).document_sequence);
      const saveSentinel = async (label: string) => {
        const text = sentinel.document.getText('content'); text.insert(text.length, `${label}\n`);
        await expect.poll(async () => {
          const checkpoint = await context.request.post('/api/files/collaboration/checkpoint', { headers,
            data: { token: sentinel.session.token, stateVector: Buffer.from(Y.encodeStateVector(sentinel.document)).toString('base64'),
              stateProof: collaborationStateProof(sentinel.document, Y) } });
          return checkpoint.ok();
        }, { timeout: 30_000, intervals: [500, 1_000] }).toBe(true);
        const current = await row(sentinel.session.documentName);
        expect(Number(current.document_sequence)).toBeGreaterThan(savedSequence); savedSequence = Number(current.document_sequence);
        expect(await disk('copies/target.txt')).toBe(text.toString());
        expect(sentinel.provider.isSynced).toBe(true);
      };
      const blockedPathAction = async (invoke: () => Promise<APIResponse>) => {
        const beforeBytes = { target: await disk('source/owned.txt'), sentinel: await disk('copies/target.txt') };
        const identity = (state: Awaited<ReturnType<typeof row>>) => ({ documentId: state.document_id,
          path: state.path, status: state.status, generation: state.lifecycle_generation, owner: state.room_owner_token });
        const beforeTarget = identity(await row(target.session.documentName));
        const beforeSentinel = identity(await row(sentinel.session.documentName));
        for (let attempt = 0; ; attempt += 1) {
          const response = await invoke();
          if (response.status() !== 409 || (await response.json()).code !== 'PREVIEW_STALE' || attempt >= 3) {
            return operation(response, 'blocked');
          }
          // A late atomic projection can invalidate the read-only snapshot.
          // Retry only while physical bytes and both live identities are intact;
          // PREVIEW_STALE never substitutes for the required lifecycle refusal.
          expect(await disk('source/owned.txt')).toBe(beforeBytes.target);
          expect(await disk('copies/target.txt')).toBe(beforeBytes.sentinel);
          expect(identity(await row(target.session.documentName))).toEqual(beforeTarget);
          expect(identity(await row(sentinel.session.documentName))).toEqual(beforeSentinel);
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      };
      for (const [label, url, data] of [
        ['rename', '/api/files/rename', { oldPath: 'source/owned.txt', newPath: 'source/renamed.txt' }],
        ['move folder', '/api/files/rename', { oldPath: 'source', newPath: 'moved' }],
        ['copy open source', '/api/files/copy', { sources: ['source/owned.txt'], destDir: 'copies' }],
      ] as const) {
        await blockedPathAction(() => context.request.post(url, { headers, data }));
        expect(await disk('source/owned.txt')).toBe(original);
        expect((await row(target.session.documentName)).path).toBe('source/owned.txt');
        await saveSentinel(`survived ${label}`);
      }
      await blockedPathAction(() => context.request.delete('/api/files/delete', { headers, data: { path: 'source/owned.txt' } }));
      expect(await disk('source/owned.txt')).toBe(original);
      await absent('source/renamed.txt'); await absent('moved/owned.txt'); await absent('copies/owned.txt');
      await saveSentinel('survived trash');

      // A neighboring active editor must not turn the whole destination directory into a busy scope.
      const copied = await context.request.post('/api/files/copy', { headers, data: { sources: ['copy-source/neighbor.txt'], destDir: 'copies' } });
      expect(copied.ok()).toBeTruthy(); expect(await disk('copies/neighbor.txt')).toBe('Closed independent copy.\n');
      const collision = await context.request.post('/api/files/copy', { headers,
        data: { sources: ['copy-source/target.txt'], destDir: 'copies', renameOnCollision: true } });
      const collisionPayload = await collision.json();
      expect(collision.ok(), `Collision-renamed copy must use its actual destination: ${JSON.stringify(collisionPayload)}`).toBeTruthy();
      const collisionTarget = collisionPayload.copied?.[0];
      expect(typeof collisionTarget).toBe('string'); expect(collisionTarget).not.toBe('copies/target.txt');
      expect(await disk(collisionTarget)).toBe('Collision-renamed copy.\n'); await saveSentinel('survived neighboring copies');

      target.close();
      await expect.poll(async () => (await row(target.session.documentName))?.room_owner_token, { timeout: 30_000 }).toBe(null);
      await confirmOwnerReleased(workspaceId!, target.session.documentName);
      await operation(await context.request.post('/api/files/rename', { headers,
        data: { oldPath: 'source/owned.txt', newPath: 'source/renamed.txt' } }), 'applied');
      await operation(await context.request.post('/api/files/rename', { headers, data: { oldPath: 'source', newPath: 'moved' } }), 'applied');
      expect(await disk('moved/renamed.txt')).toBe(original);
      expect((await row(target.session.documentName)).path).toBe('moved/renamed.txt');
      const closedCopy = await context.request.post('/api/files/copy', { headers, data: { sources: ['moved/renamed.txt'], destDir: 'copies' } });
      expect(closedCopy.ok()).toBeTruthy(); expect(await disk('copies/renamed.txt')).toBe(original);
      const deleted = await operation(await context.request.delete('/api/files/delete', { headers, data: { path: 'moved' } }), 'applied');
      const trashEntry = deleted.trashEntries?.find(entry => entry.originalPath === 'moved');
      expect(trashEntry?.id).toBeTruthy(); await absent('moved/renamed.txt');
      const archived = await row(target.session.documentName); expect(archived.status).toBe('archived');
      await upload('pending.txt', 'Pending physical original.\n');
      const requestScopes = ['moved', 'pending.txt'].map(filePath => ({ workspaceId: workspaceId!, organizationId: archived.organization_id,
        path: filePath, kind: filePath === 'moved' ? 'subtree' as const : 'exact' as const }));
      const expectedRows = (await database.query(`SELECT * FROM collaboration_yjs_states WHERE workspace_id=$1
        AND (path='pending.txt' OR path='moved' OR left(path,6)='moved/')`, [workspaceId])).rows;
      const expectedDocuments: CollaborationAdmissionDocument[] = expectedRows.map(current => ({ documentId: current.document_id,
        workspaceId: workspaceId!, organizationId: current.organization_id, path: current.path, representation: current.representation,
        lifecycleGeneration: Number(current.lifecycle_generation), schemaVersion: Number(current.schema_version), status: current.status }));
      const actionPayloadText = JSON.stringify({ fixture: randomUUID(), phase: 'closed-path-guard' });
      const request = captureCollaborationAdmissionRequest({ requestId: randomUUID(), actorId: userId, action: 'restore', actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('restore', actionPayloadText), scopes: requestScopes, expectedDocuments }).request;
      const reserved = await admissionFixture('reserve', request); expect(reserved.status).toBe('reserved');
      pending = { request, revision: reserved.revision };
      const restoreURL = `/api/files/trash/${trashEntry!.id}/restore`;
      const restoreDenied = await context.request.post(restoreURL, { headers });
      expect(restoreDenied.status()).toBe(409); expect((await restoreDenied.json()).code).toBe('COLLABORATION_FILE_LIFECYCLE_BUSY');
      await absent('moved/renamed.txt'); expect((await row(target.session.documentName)).status).toBe('archived');
      await operation(await context.request.post('/api/files/rename', { headers, data: { oldPath: 'pending.txt', newPath: 'pending-renamed.txt' } }), 'blocked');
      await operation(await context.request.delete('/api/files/delete', { headers, data: { path: 'pending.txt' } }), 'blocked');
      await operation(await context.request.post('/api/files/copy', { headers, data: { sources: ['pending.txt'], destDir: 'copies' } }), 'blocked');
      expect(await disk('pending.txt')).toBe('Pending physical original.\n'); await absent('copies/pending.txt');
      await saveSentinel('survived pending admission');
      expect((await admissionFixture('cancel', pending.request, pending.revision)).status).toBe('cancelled'); pending = undefined;
      const restored = await context.request.post(restoreURL, { headers }); expect(restored.ok()).toBeTruthy();
      expect(await disk('moved/renamed.txt')).toBe(original);
      const restoredRow = await row(target.session.documentName); expect(restoredRow.status).toBe('active');
      expect(Number(restoredRow.lifecycle_generation)).toBeGreaterThan(Number(archived.lifecycle_generation));
      await saveSentinel('survived closed restore');
      await info.attach('managed-owner-lifecycle-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ workspaceId,
        ownerEpoch: restoredRow.room_owner_epoch, restoredGeneration: restoredRow.lifecycle_generation,
        sentinelDocumentSequence: savedSequence, layers: ['production HTTP', 'authenticated WebSocket', 'actual PostgreSQL admission/owner', 'physical download'] })) });
    } finally {
      if (pending) await admissionFixture('cancel', pending.request, pending.revision);
      for (const room of rooms) room.close();
      if (workspaceId) {
        await expect.poll(async () => Number((await database.query(`SELECT count(*) AS count FROM collaboration_yjs_states
          WHERE workspace_id=$1 AND room_owner_token IS NOT NULL`, [workspaceId])).rows[0].count), { timeout: 30_000 }).toBe(0);
        const cleanup = await context.request.delete(`/api/workspaces/${workspaceId}`); expect(cleanup.ok()).toBeTruthy();
      }
      await context.close(); await database.end();
    }
  });
});
