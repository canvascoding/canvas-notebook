import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';

import { db } from '../app/lib/db';
import { user, agents, canvasWorkspaces, piSessions } from '../app/lib/db/schema';
import { DEFAULT_MANAGED_AGENT_ID, SYSTEM_MANAGED_AGENT_IDS } from '../app/lib/agents/storage';
import { normalizeMainAgentIdAlias } from '../app/lib/agents/main-agent';
import {
  resolveAgentExecutionContextForStoredSession, resolveAgentSessionWorkspaceForUser, workspaceToPiSessionFields,
} from '../app/lib/pi/session-workspace-context';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { loadCollaborationState } from '../app/lib/collaboration/persistence';
import { prepareCollaborationBlockEdit } from '../app/lib/collaboration/agent-file-edits';
import { applyPersistedAgentTextOperation, createAgentTextTarget, rejectAgentOperation,
  type AgentTextTarget } from '../app/lib/collaboration/agent-operations';
import { resolveAgentDirectEditGrant, setAgentDirectEditGrantForOperation } from '../app/lib/collaboration/agent-direct-edit-grants';

/** Real users, workspace permissions, agent ownership and stored sessions; no authority or license mocks. */
export async function ensureAgentGrantIntegrationFixture(input: {
  userId?: string;
  agentId?: string;
  sessionId?: string;
  workspace?: Pick<WorkspaceContext, 'workspaceId' | 'rootPath'> & { workspaceType: 'personal' | 'organization' };
} = {}) {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const url = new URL(process.env.DATABASE_URL!);
  assert.match(url.pathname, /^\/canvas_editor_test_\w+$/u, 'Only a disposable collaboration test database is allowed.');
  assert.ok(process.env.DATA && path.isAbsolute(process.env.DATA), 'An isolated absolute DATA directory is required.');
  const userId = input.userId ?? `grant-test-${randomUUID()}`;
  const now = new Date();
  await db.insert(user).values({ id: userId, name: 'Collaboration grant test user',
    email: `${userId}@example.test`, emailVerified: true, role: 'admin', createdAt: now, updatedAt: now });
  // Uses the application bootstrap to create the organization, owner permission and personal workspace.
  let workspace = await resolveAgentSessionWorkspaceForUser({ userId, permissions: ['canRead', 'canWrite', 'canRunAgent'] });
  if (input.workspace) {
    const rootRelativePath = path.relative(process.env.DATA, input.workspace.rootPath);
    assert.ok(rootRelativePath && rootRelativePath !== '..' && !rootRelativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(rootRelativePath), 'Fixture workspace must be inside isolated DATA.');
    assert(workspace.organizationId);
    // A persisted workspace fixture preserves shared-workspace regression semantics. It creates no
    // license, entitlement, team-seat, membership billing, or feature-configuration records.
    await db.insert(canvasWorkspaces).values({ id: input.workspace.workspaceId, organizationId: workspace.organizationId,
      type: input.workspace.workspaceType, ownerUserId: input.workspace.workspaceType === 'personal' ? userId : null,
      rootRelativePath, displayName: 'Collaboration integration workspace', status: 'active',
      createdAt: now, updatedAt: now });
    await fs.mkdir(input.workspace.rootPath, { recursive: true });
    workspace = await resolveAgentSessionWorkspaceForUser({ userId, workspaceId: input.workspace.workspaceId,
      permissions: ['canRead', 'canWrite', 'canRunAgent'] });
  }
  assert(workspace.permissions.canWrite && workspace.permissions.canRunAgent);

  const sessions = new Map<string, AgentExecutionContext>();
  async function ensureSession(agentId = DEFAULT_MANAGED_AGENT_ID, sessionId = `grant-session-${randomUUID()}`) {
    const key = JSON.stringify([agentId, sessionId]);
    const existing = sessions.get(key);
    if (existing) return existing;
    if (!(SYSTEM_MANAGED_AGENT_IDS as readonly string[]).includes(normalizeMainAgentIdAlias(agentId))) {
      await db.insert(agents).values({ agentId, name: 'Owned collaboration test agent', type: 'custom',
        accessPolicy: 'restricted', scopeType: 'user', ownerUserId: userId, createdByUserId: userId,
        createdAt: now, updatedAt: now }).onConflictDoNothing();
    }
    await db.insert(piSessions).values({ userId, sessionId, agentId, provider: 'test', model: 'test',
      title: 'Collaboration grant fixture', createdAt: now, updatedAt: now, ...workspaceToPiSessionFields(workspace) });
    const execution = await resolveAgentExecutionContextForStoredSession({ userId, sessionId, agentId,
      permissions: ['canRead', 'canWrite', 'canRunAgent'] });
    assert.equal(execution.workspaceId, workspace.workspaceId);
    assert.equal(execution.workspaceRoot, workspace.rootPath);
    sessions.set(key, execution);
    return execution;
  }
  const execution = await ensureSession(input.agentId, input.sessionId);

  async function grantForDocument(request: {
    documentId: string;
    lifecycleGeneration?: number;
    agentId?: string;
    actorSessionId?: string;
    targets?: AgentTextTarget[];
  }) {
    const actor = request.agentId || request.actorSessionId
      ? await ensureSession(request.agentId ?? execution.agentId!, request.actorSessionId ?? execution.sessionId)
      : execution;
    const state = await loadCollaborationState(request.documentId);
    assert(state && state.status === 'active');
    assert.equal(state.workspaceId, workspace.workspaceId);
    if (request.lifecycleGeneration !== undefined) assert.equal(state.lifecycleGeneration, request.lifecycleGeneration);
    const scope = { userId, workspaceId: workspace.workspaceId, agentId: actor.agentId!, actorSessionId: actor.sessionId,
      documentId: state.documentId, lifecycleGeneration: state.lifecycleGeneration };
    const existing = await resolveAgentDirectEditGrant(scope);
    if (existing) return existing;
    let targets = request.targets;
    if (!targets && state.representation === 'tiptap_blocks') {
      targets = (await prepareCollaborationBlockEdit({ document: { documentId: state.documentId,
        lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion }, workspace, path: state.path,
      groupId: 'grant-fixture', operations: [{ kind: 'insert_blocks', parentId: null, beforeId: null,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Permission fixture proposal' }] }] }] })).targets;
    } else if (!targets) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state.yjsState);
        const firstXmlText = (fragment: Y.XmlFragment): Y.XmlText | null => {
          for (const child of fragment.toArray()) {
            if (child instanceof Y.XmlText) return child;
            if (child instanceof Y.XmlElement) {
              const nested = firstXmlText(child);
              if (nested) return nested;
            }
          }
          return null;
        };
        const text = state.representation === 'tiptap_xml' ? firstXmlText(doc.getXmlFragment('body')) : doc.getText('content');
        assert(text, 'The XML permission fixture needs an existing anchored text node.');
        targets = [createAgentTextTarget({ text, from: 0, to: 0,
          replacement: 'Permission fixture proposal', groupId: 'grant-fixture' })];
      } finally { doc.destroy(); }
    }
    const proposal = await applyPersistedAgentTextOperation({ documentId: state.documentId, workspace,
      initiatedByUserId: userId, actorId: actor.agentId!, actorSessionId: actor.sessionId, actorDisplayName: 'Fixture agent',
      idempotencyKey: randomUUID(), runGeneration: 1, requestedMode: 'review', targets });
    const grant = await setAgentDirectEditGrantForOperation({ operationId: proposal.operationId, workspace, userId,
      action: 'grant', idempotencyKey: randomUUID() });
    assert(grant?.active, 'The real current-rights resolver must authorize this explicitly granted scope.');
    await rejectAgentOperation({ operationId: proposal.operationId, workspace, userId, idempotencyKey: randomUUID() });
    assert.deepEqual(await resolveAgentDirectEditGrant(scope), { id: grant.id, expiresAt: grant.expiresAt });
    return { id: grant.id, expiresAt: grant.expiresAt };
  }

  return { userId, workspace, execution, ensureSession, grantForDocument };
}
