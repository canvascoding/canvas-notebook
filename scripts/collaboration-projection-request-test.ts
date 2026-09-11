import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import * as Y from 'yjs';

import { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { FileGuestCheckpointRequestError } from '../app/lib/file-guests/checkpoint-error';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type * as AccountRoute from '../app/api/files/collaboration/checkpoint/route';
import type * as GuestCollaboration from '../app/lib/file-guests/collaboration';
import type * as GuestHttp from '../app/lib/file-guests/http';
import type * as GuestVersions from '../app/lib/file-guests/versions';

/** Execute the actual boundary/recorder; substitute only external dependencies. */
async function compileDependency<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as T;
}

const privateText = 'PRIVATE_DOCUMENT_CONTENT_MUST_NOT_LEAK';
const privatePath = 'private-folder/private-document.md';
const privateToken = 'PRIVATE_GUEST_TOKEN_MUST_NOT_LEAK';

function snapshot(doc: Y.Doc): PersistedCollaborationState {
  return { documentId: 'document', workspaceId: 'workspace', organizationId: 'organization', path: privatePath,
    representation: 'plain_text', lifecycleGeneration: 2, schemaVersion: 1, documentSequence: 7, checkpointSequence: 6,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), status: 'active',
    persistedAt: 1, checkpointedAt: 0, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false };
}

class GuestAccessError extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}
class SupersededError extends Error {}

async function requestHarness(channel: 'account' | 'guest') {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, `X${privateText}`);
  const beforeDelete = collaborationStateProof(doc, Y);
  const beforeVector = Y.encodeStateVector(doc);
  doc.getText('content').delete(0, 1);
  assert.deepEqual(Y.encodeStateVector(doc), beforeVector, 'pure deletion keeps its old vector');
  const state = snapshot(doc);
  const proof = collaborationStateProof(doc, Y);
  assert.ok(proof, 'a valid Yjs snapshot has a binary state proof');
  assert.notEqual(proof, beforeDelete);
  const workspace = { workspaceId: state.workspaceId, organizationId: state.organizationId };
  const claims = { ...state, provider: 'yjs', permission: 'write', userId: 'user', sessionId: 'session',
    guestInvitationId: 'invitation', guestPolicyRevision: 3 };
  const found = { state, workspace, user: { id: 'user' }, guestSession: { id: 'session' },
    invitation: { policyRevision: 3, permission: 'write' } };
  const controls = { materializeError: null as Error | null, accessDenied: false, ticketError: null as Error | null,
    materialized: 0, loaded: 0, diagnostics: [] as unknown[][] };
  const mocks = {
    '@/app/lib/collaboration/server-runtime': { Y },
    '@/app/lib/collaboration/diagnostics': { logCollaborationDiagnostic: (...args: unknown[]) => controls.diagnostics.push(args) },
    '@/app/lib/collaboration/ticket': { verifyCollaborationTicket() {
      if (controls.ticketError) throw controls.ticketError;
      return claims;
    } },
    '@/app/lib/collaboration/checkpoint': { CollaborationCheckpointSupersededError: SupersededError,
      materializeCollaborationCheckpoint: async (input: { state: PersistedCollaborationState }) => {
        controls.materialized++;
        assert.equal(input.state, state, 'materialization receives the authorized persisted snapshot');
        if (controls.materializeError) throw controls.materializeError;
        return { state: { ...state, checkpointSequence: state.documentSequence }, revisionId: 'revision', content: privateText };
      } },
    '@/app/lib/collaboration/persistence': { loadCollaborationState: async () => { controls.loaded++; return state; } },
    '@/app/lib/audit/audit-service': { recordAuditEvent: async () => {} },
    '@/app/lib/api/route-helpers': { applyRateLimit: () => null, readJsonBody: (request: NextRequest) => request.json() },
    '@/app/lib/workspaces/request': { requireRequestWorkspace: async () => controls.accessDenied
      ? { response: NextResponse.json({ success: false, error: 'Access denied.' }, { status: 403 }) }
      : { workspace, session: { user: { id: 'user' }, session: { id: 'session' } } } },
    './service': { FileGuestError: GuestAccessError, fileGuestService: { access: async () => {
      if (controls.accessDenied) throw new GuestAccessError('Access denied.');
      return found;
    } } },
    './checkpoint-error': { FileGuestCheckpointRequestError },
  };
  const route = channel === 'account'
    ? await compileDependency<typeof AccountRoute>('app/api/files/collaboration/checkpoint/route.ts', mocks) : null;
  const guest = channel === 'guest'
    ? await compileDependency<typeof GuestCollaboration>('app/lib/file-guests/collaboration.ts', mocks) : null;
  const http = channel === 'guest' ? await compileDependency<typeof GuestHttp>('app/lib/file-guests/http.ts', {
    ...mocks, './versions': { FileGuestVersionError: class extends Error {} },
    '@/app/lib/security/trusted-origins': {}, '@/app/lib/utils/rate-limit': {},
    '@/app/lib/license/entitlements': { LicenseEntitlementError: class extends Error {} },
  }) : null;
  const request = async (stateProof: unknown = proof): Promise<Response> => {
    const vector = Buffer.from(state.stateVector).toString('base64');
    if (route) return route.POST(new NextRequest('https://canvas.test/api/files/collaboration/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: privateToken, stateVector: vector, stateProof }),
    }));
    try { return http!.fileGuestJson(await guest!.fileGuestCheckpoint('invitation', privateToken, 'ticket', vector, stateProof)); }
    catch (error) { return http!.fileGuestErrorResponse(error); }
  };
  return { doc, state, proof, beforeDelete, claims, found, controls, request };
}

function assertSafe(body: Record<string, unknown>, diagnostics: unknown[][]): void {
  const serialized = JSON.stringify([body, diagnostics]);
  for (const secret of [privateText, privatePath, privateToken, 'EACCES raw OS error', 'stack-private']) {
    assert.equal(serialized.includes(secret), false, `response/diagnostics must not disclose ${secret}`);
  }
  for (const key of ['content', 'yjsState', 'token', 'path', 'stack', 'cause']) assert.equal(Object.hasOwn(body, key), false);
}

function assertSnapshot(body: Record<string, unknown>, state: PersistedCollaborationState, proof: string): void {
  for (const key of ['documentId', 'lifecycleGeneration', 'documentSequence', 'checkpointSequence'] as const) {
    assert.equal(body[key], state[key], `snapshot ${key} must describe the exact authorized binary state`);
  }
  assert.equal(body.stateVector, Buffer.from(state.stateVector).toString('base64'));
  assert.equal(body.stateProof, proof, 'proof includes the delete set, unlike the vector alone');
}

for (const channel of ['account', 'guest'] as const) {
  test(`${channel}: projection responses preserve exact persisted proof and sanitize failures`, async (t) => {
    const fixture = await requestHarness(channel);
    const { controls, request, state, proof, doc } = fixture;
    try {
      for (const [name, error, status, code] of [
        ['roundtrip conversion', new CollaborationCheckpointValidationError('roundtrip_unstable'), 422, COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable],
        ['filesystem output', new Error(`EACCES raw OS error ${privatePath} ${privateText} ${privateToken}`), 500, COLLABORATION_CHECKPOINT_ERROR_CODES.failed],
        ['schema', new CollaborationCheckpointValidationError('schema_invalid'), 422, COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid],
        ['stable identity', new CollaborationCheckpointValidationError('stable_id_missing'), 422, COLLABORATION_CHECKPOINT_ERROR_CODES.stableIdMissing],
      ] as const) {
        await t.test(name, async () => {
          controls.materializeError = error;
          error.stack = 'stack-private';
          const response = await request();
          const body = await response.json();
          assert.equal(response.status, status);
          assert.equal(body.success, false, 'adding a durable snapshot must never turn an export failure into HTTP success');
          assert.equal(body.code, code);
          assertSnapshot(body, state, proof);
          assertSafe(body, controls.diagnostics);
          if (channel === 'guest') {
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
          }
        });
      }
      await t.test('successful export returns the newly checkpointed sequence', async () => {
        controls.materializeError = null;
        const response = await request();
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.success, true);
        assertSnapshot(body, { ...state, checkpointSequence: state.documentSequence }, proof);
        assert.equal(body.revisionId, 'revision');
        assertSafe(body, controls.diagnostics);
      });
      await t.test('superseded export stays a conflict', async () => {
        controls.materializeError = new SupersededError(privateText);
        const response = await request();
        const body = await response.json();
        assert.equal(response.status, 409);
        assert.equal(body.success, false);
        assert.equal(body.code, COLLABORATION_CHECKPOINT_ERROR_CODES.superseded);
        assertSafe(body, controls.diagnostics);
      });
    } finally { doc.destroy(); }
  });

  test(`${channel}: rejected access, lifecycle and stale delete proofs never expose a durable snapshot`, async (t) => {
    const { controls, request, claims, found, beforeDelete, doc } = await requestHarness(channel);
    const denied = async (status: number, proof?: unknown) => {
      const before = controls.materialized;
      const response = await request(proof);
      const body = await response.json();
      assert.equal(response.status, status);
      assert.equal(body.success, false);
      assert.equal(controls.materialized, before, 'an unauthorized/stale request cannot reach file output');
      for (const field of ['documentId', 'documentSequence', 'checkpointSequence', 'stateVector', 'stateProof']) {
        assert.equal(Object.hasOwn(body, field), false, `denied requests cannot disclose ${field}`);
      }
      assert.notEqual(body.code, COLLABORATION_CHECKPOINT_ERROR_CODES.failed, 'auth denial must not look like a nonblocking export error');
      assertSafe(body, controls.diagnostics);
    };
    try {
      await t.test('missing workspace or guest access', async () => {
        controls.accessDenied = true;
        await denied(403);
        assert.equal(controls.loaded, 0);
        controls.accessDenied = false;
      });
      await t.test('read-only ticket', async () => {
        claims.permission = 'read'; await denied(403); claims.permission = 'write';
      });
      await t.test('other session', async () => {
        claims.sessionId = 'another-session'; await denied(403); claims.sessionId = 'session';
      });
      await t.test('other workspace', async () => {
        claims.workspaceId = 'another-workspace'; await denied(403); claims.workspaceId = 'workspace';
      });
      await t.test('old generation', async () => {
        claims.lifecycleGeneration--; await denied(channel === 'account' ? 409 : 403); claims.lifecycleGeneration++;
      });
      if (channel === 'guest') await t.test('revoked guest policy', async () => {
        found.invitation.policyRevision++; await denied(403); found.invitation.policyRevision--;
      });
      await t.test('same vector but stale pre-deletion proof', async () => { await denied(409, beforeDelete); });
      await t.test('missing proof', async () => { await denied(400, null); });
      await t.test('invalid or expired ticket', async () => {
        controls.ticketError = new Error(`Collaboration ticket expired. ${privateToken}`);
        await denied(401);
      });
    } finally { doc.destroy(); }
  });
}

for (const representation of ['plain_text', 'tiptap_blocks', 'tiptap_xml'] as const) {
  test(`${representation}: normal guest history uses persisted bytes; forced restore backup uses current live content`, async () => {
    const persisted = representation === 'plain_text' ? new Y.Doc() : createRichMarkdownYDoc('Saved **version**', representation);
    const live = representation === 'plain_text' ? new Y.Doc() : createRichMarkdownYDoc('New **unsaved** version', representation);
    if (representation === 'plain_text') {
      persisted.getText('content').insert(0, 'XSaved version');
      persisted.getText('content').delete(0, 1);
      live.getText('content').insert(0, 'New unsaved version');
    }
    const state = { ...snapshot(persisted), representation };
    const expected = (doc: Y.Doc) => representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc);
    const inserts: Array<Record<string, unknown>> = [];
    const invitationTable = { id: 'invitation-id', documentId: 'invitation-document' };
    const versionTable = { id: 'version-id', documentId: 'version-document', createdAt: 'version-created' };
    let liveReads = 0;
    let invitationReads = 0;
    const versions = await compileDependency<typeof GuestVersions>('app/lib/file-guests/versions.ts', {
      '@/app/lib/db/schema': { fileGuestInvitations: invitationTable, fileGuestVersions: versionTable },
      'drizzle-orm': { eq: (...values: unknown[]) => values, desc: (value: unknown) => value,
        and: (...values: unknown[]) => values, inArray: (...values: unknown[]) => values },
      '@/app/lib/db': { db: {
        select: () => {
          let table: unknown;
          const query = {
            from(value: unknown) { table = value; return query; }, where() { return query; },
            orderBy() { return query; }, offset() { return query; },
            async limit() { if (table === invitationTable) { invitationReads++; return [{ id: 'invitation' }]; } return []; },
          };
          return query;
        },
        insert: () => ({ values: (value: Record<string, unknown>) => ({ onConflictDoNothing: async () => { inserts.push(value); } }) }),
      } },
      '@/app/lib/collaboration/server-runtime': { Y },
      '@/app/lib/collaboration/document-access': { readCurrentCollaborationDocument: async (input: {
        documentId: string; workspaceId: string; read: (doc: Y.Doc) => string;
      }) => { liveReads++; assert.equal(input.documentId, state.documentId); assert.equal(input.workspaceId, state.workspaceId); return input.read(live); } },
      '@/app/lib/collaboration/persistence': {}, '@/app/lib/collaboration/direct-connection': {},
      '@/app/lib/files/collaboration-policy': {},
    });
    try {
      await versions.recordFileGuestVersion(state);
      assert.equal(liveReads, 0, 'normal background history must not accidentally capture a newer live state');
      assert.equal(invitationReads, 1);
      await versions.recordFileGuestVersion(state, true);
      assert.equal(liveReads, 1, 'explicit restore backup includes edits not persisted yet');
      assert.equal(invitationReads, 1, 'an explicit backup does not depend on current invitations');
      assert.equal(inserts.length, 2);
      for (const [index, expectedDoc] of [persisted, live].entries()) {
        const content = expected(expectedDoc);
        assert.equal(inserts[index].content, content);
        assert.equal(inserts[index].contentHash, createHash('sha256').update(content).digest('hex'));
        assert.equal(inserts[index].documentId, state.documentId);
        assert.equal(inserts[index].workspaceId, state.workspaceId);
        assert.equal(inserts[index].lifecycleGeneration, state.lifecycleGeneration);
        assert.equal(inserts[index].documentSequence, state.documentSequence);
      }
      assert.notEqual(inserts[0].content, inserts[1].content);
      assert.deepEqual(state.yjsState, Y.encodeStateAsUpdate(persisted), 'recording history does not mutate the supplied snapshot');
    } finally { persisted.destroy(); live.destroy(); }
  });
}
