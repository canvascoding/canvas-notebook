import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

type Row = { id: number; sessionId: string; userId: string; agentId: string; title: string; organizationId: string | null; workspaceId: string };
type Message = { role: string; content: string; timestamp: number; sequence: number };
type State = { target: Row | null; requestId: string | null; sourcePresent: boolean; targetMessages: Message[]; snapshot: { target: Row | null; messages: Message[] } | null; deleteStep: number; sourceMessages: Message[] };

const userId = 'tool-output-lifecycle-user';
const agentId = 'tool-output-lifecycle-agent';
const workspaceId = 'lifecycle-workspace';
const sourceSessionId = 'source-session';
const source: Row = { id: 11, sessionId: sourceSessionId, userId, agentId, title: 'Lifecycle session', organizationId: null, workspaceId };

function createState(reference: string, laterReference: string): State {
  return {
    target: null, requestId: null, sourcePresent: true, targetMessages: [], snapshot: null, deleteStep: 0,
    sourceMessages: [
      { role: 'toolResult', content: JSON.stringify({ role: 'toolResult', details: { toolOutput: { version: 1, policyVersion: 'phase2-v1', references: [{ reference }] } } }), timestamp: 1, sequence: 1 },
      { role: 'assistant', content: JSON.stringify({ content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }), timestamp: 2, sequence: 2 },
      { role: 'toolResult', content: JSON.stringify({ role: 'toolResult', details: { toolOutput: { version: 1, policyVersion: 'phase2-v1', references: [{ reference: laterReference }] } } }), timestamp: 3, sequence: 3 },
    ],
  };
}

function createMocks(getState: () => State) {
  const db = {
    query: { piSessions: { findFirst: async () => {
      const target = getState().target;
      return target && { id: target.id, sessionId: target.sessionId, userId: target.userId, agentId: target.agentId };
    } } },
    select: () => ({ from: () => ({ where: async () => {
      const state = getState(); state.deleteStep = 0;
      return state.sourcePresent ? [{ id: source.id, sessionId: source.sessionId, userId, organizationId: null, workspaceId }] : [];
    } }) }),
    delete: () => ({ where: () => ({ returning: async () => {
      const state = getState(); state.deleteStep += 1;
      if (state.deleteStep === 1) return [];
      if (state.deleteStep === 2 || state.deleteStep === 3) return [];
      if (state.deleteStep === 4) {
        if (!state.sourcePresent) return [];
        state.sourcePresent = false;
        return [{ id: source.id }];
      }
      // With no selected session, deletion skips channel rows.
      if (state.deleteStep === 2 && !state.sourcePresent) return [];
      throw new Error(`Unexpected delete step ${state.deleteStep}`);
    } }) }),
  };
  const connection = {
    async run(sql: string) {
      const statement = sql.replace(/\s+/gu, ' ').trim(); const state = getState();
      if (statement === 'BEGIN') { state.snapshot = { target: state.target && { ...state.target }, messages: state.targetMessages.map((m) => ({ ...m })) }; return { changes: 0 }; }
      if (statement === 'COMMIT') return { changes: 0 };
      if (statement === 'ROLLBACK') { if (state.snapshot) { state.target = state.snapshot.target; state.targetMessages = state.snapshot.messages; } return { changes: 0 }; }
      if (statement.startsWith('INSERT INTO pi_messages')) { state.targetMessages = state.sourceMessages.filter((m) => m.sequence <= 2).map((m) => ({ ...m })); return { changes: 2 }; }
      if (statement.startsWith('UPDATE session_channel_links') || statement.startsWith('INSERT INTO session_channel_links')) return { changes: 1 };
      throw new Error(`Unexpected SQL run: ${statement}`);
    },
    async get(sql: string, params: unknown[] = []) {
      const statement = sql.replace(/\s+/gu, ' ').trim(); const state = getState();
      if (statement.startsWith('SELECT id FROM "user"')) return { id: params[0] };
      if (statement.startsWith('SELECT id, session_id, user_id, agent_id, title,')) return {
        id: source.id, session_id: source.sessionId, user_id: userId, agent_id: agentId, title: source.title, title_generation_state: 'manual',
        session_kind: 'conversation', forked_from_session_id: null, forked_from_sequence: null, summary_text: null, summary_updated_at: null,
        summary_through_timestamp: null, summary_through_sequence: null, summary_revision: 0, organization_id: null, customer_id: null,
        project_id: null, workspace_id: workspaceId, workspace_type: 'team', workspace_name: 'Workspace', workspace_root_relative_path: null,
      };
      if (statement.startsWith('SELECT role, content, timestamp, sequence')) return state.sourceMessages.find((m) => m.sequence === params[1]);
      if (statement.startsWith('SELECT COUNT(*) AS message_count, COUNT(DISTINCT sequence)')) return { message_count: 2, distinct_sequence_count: 2, minimum_sequence: 1, maximum_sequence: 2 };
      if (statement.startsWith('INSERT INTO pi_sessions')) {
        state.target = { id: 12, sessionId: String(params[0]), userId, agentId, title: String(params[7]), organizationId: null, workspaceId };
        state.requestId = String(params[1]); return { id: 12 };
      }
      if (statement.startsWith('SELECT COUNT(*) AS message_count FROM pi_messages')) return { message_count: state.targetMessages.length };
      throw new Error(`Unexpected SQL get: ${statement}`);
    },
    async all(sql: string, params: unknown[] = []) {
      const statement = sql.replace(/\s+/gu, ' ').trim(); const state = getState();
      if (statement.startsWith('SELECT id, session_id, user_id, agent_id, workspace_id, session_kind,')) {
        if (!state.target || state.requestId !== params[1]) return [];
        return [{ id: state.target.id, session_id: state.target.sessionId, user_id: userId, agent_id: agentId, workspace_id: workspaceId, session_kind: 'conversation', forked_from_session_id: sourceSessionId, forked_from_sequence: 2 }];
      }
      if (statement.startsWith('SELECT title FROM pi_sessions')) return [{ title: source.title }];
      if (statement.startsWith('SELECT content FROM pi_messages')) return state.sourceMessages.filter((m) => m.sequence <= 2).map((m) => ({ content: m.content }));
      throw new Error(`Unexpected SQL all: ${statement}`);
    },
    async close() {},
  };
  return { db, connection };
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tool-output-lifecycle-'));
  process.env.DATA = dataDir; process.env.CANVAS_DATA_ROOT = dataDir;
  let state: State;
  const { db, connection } = createMocks(() => state);
  const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = modules._load;
  modules._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/db' || request.endsWith('/app/lib/db')) return { db, openDb: async () => connection };
    if (request === '@/app/lib/db/legacy-ai-tables' || request.endsWith('/db/legacy-ai-tables')) return { legacyAiTablesExist: async () => false };
    if (request === '@/app/lib/pi/session-user-state-lock' || request.endsWith('/pi/session-user-state-lock')) return { lockPiSessionCreationForUser: async () => undefined, withPiSessionUserStateLock: async (_id: string, run: () => Promise<unknown>) => run() };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { forkPiSession } = await import('../app/lib/pi/session-fork');
    const { deletePiSessionsByDbIds } = await import('../app/lib/pi/session-deletion');
    const { readStoredToolOutput, storeToolOutput } = await import('../app/lib/pi/tool-output-store');
    const sourceIdentity = { organizationId: null, userId, sessionId: sourceSessionId, workspaceId };
    const stored = await storeToolOutput({ identity: sourceIdentity, toolCallId: 'fork-call', content: 'source output retained across a fork', format: 'text' });
    if (!stored.ok) throw new Error(stored.error);
    const later = await storeToolOutput({ identity: sourceIdentity, toolCallId: 'later-call', content: 'later output must not be copied', format: 'text' });
    if (!later.ok) throw new Error(later.error);
    state = createState(stored.reference, later.reference);
    const input: Parameters<typeof forkPiSession>[0] = {
      sourceSessionId, targetSessionId: 'fork-session', clientRequestId: 'fork-request', userId, agentId, workspaceId, workspaceType: 'team', throughSequence: 2,
      runtimeSnapshot: { selection: { providerId: 'test', modelId: 'test', thinkingLevel: 'low', providerInstallationId: 'test-installation' }, catalogRevision: 1, policyRevision: 1, selectionSource: 'session' },
      systemPromptSnapshot: { systemPrompt: 'prompt', systemPromptHash: 'hash', systemPromptCreatedAt: new Date() },
    };
    assert.equal((await forkPiSession(input)).created, true);
    const targetIdentity = { ...sourceIdentity, sessionId: 'fork-session' };
    assert.equal((await readStoredToolOutput(targetIdentity, stored.reference)).content, 'source output retained across a fork');
    await assert.rejects(() => readStoredToolOutput(targetIdentity, later.reference), /not found/i);
    assert.equal((await forkPiSession(input)).created, false, 'idempotency retries must not clone into an existing target');
    assert.equal((await deletePiSessionsByDbIds([source.id])).sessionCount, 1);
    await assert.rejects(() => readStoredToolOutput(sourceIdentity, stored.reference));
    assert.equal((await readStoredToolOutput(targetIdentity, stored.reference)).content, 'source output retained across a fork');
    assert.equal((await deletePiSessionsByDbIds([source.id])).sessionCount, 0, 'deletion retries are safe');
    assert.equal((await readStoredToolOutput(targetIdentity, stored.reference)).content, 'source output retained across a fork');

    const preexistingTarget = { ...sourceIdentity, sessionId: 'failed-fork' };
    const existing = await storeToolOutput({ identity: preexistingTarget, toolCallId: 'existing', content: 'keep me', format: 'text' });
    if (!existing.ok) throw new Error(existing.error);
    const restored = await storeToolOutput({ identity: sourceIdentity, toolCallId: 'fork-call', content: 'restored source output', format: 'text' });
    if (!restored.ok) throw new Error(restored.error);
    state = createState(restored.reference, later.reference);
    await assert.rejects(() => forkPiSession({ ...input, targetSessionId: 'failed-fork', clientRequestId: 'failed-request' }));
    assert.equal(state.target, null, 'clone failure rolls the session insertion back');
    assert.equal((await readStoredToolOutput(preexistingTarget, existing.reference)).content, 'keep me', 'pre-existing files survive a failed clone');
    console.log('tool-output-lifecycle-test: ok');
  } finally {
    modules._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
