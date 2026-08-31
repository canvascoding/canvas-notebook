import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return {};
  if (request === '@earendil-works/pi-ai') {
    return {
      completeSimple: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: 'unused' }],
        stopReason: 'stop',
      }),
      getModels: () => [],
      getProviders: () => [],
      isContextOverflow: () => false,
      registerBuiltInApiProviders: () => undefined,
    };
  }
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-agent-profile-'));
  const dataRoot = path.join(tempRoot, 'data');
  const dbPath = path.join(dataRoot, 'sqlite.db');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  await fs.mkdir(dataRoot, { recursive: true });

  const sqlite = new Database(dbPath);
  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('owner-user', 'Owner', 'owner@example.test', 1, 'admin', now, now);
    sqlite.exec('BEGIN IMMEDIATE');
    ensureOrganizationBootstrapForUser(sqlite, 'owner-user');
    sqlite.exec('COMMIT');

    const {
      EMAIL_MANAGED_AGENT_ID,
      deleteAgentProfile,
      ensureEmailAgent,
      listAgentProfiles,
      updateAgentProfile,
    } = await import('../app/lib/agents/registry');
    const { getAgentAccess } = await import('../app/lib/agents/access');
    const { updateManagedAgentRuntime } = await import('../app/lib/agents/management-actions');
    const { readManagedAgentFile, resetManagedAgentFile, writeManagedAgentFile } = await import('../app/lib/agents/storage');
    const { getProgressiveGatewayCapabilityNames } = await import('../app/lib/pi/progressive-tool-gateway');
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { createEmailAgentTools } = await import('../app/lib/pi/workspace-email-tools');

    const createDraftTool = createEmailAgentTools().find((tool) => tool.name === 'email_create_outbox_draft');
    const updateDraftTool = createEmailAgentTools().find((tool) => tool.name === 'email_update_outbox_draft');
    assert.ok(createDraftTool);
    assert.ok(updateDraftTool);
    assert.ok((createDraftTool.parameters as { properties?: Record<string, unknown> }).properties?.bodyHtml);
    assert.ok((updateDraftTool.parameters as { properties?: Record<string, unknown> }).properties?.bodyHtml);
    assert.ok((createDraftTool.parameters as { properties?: Record<string, unknown> }).properties?.attachments);
    assert.ok((updateDraftTool.parameters as { properties?: Record<string, unknown> }).properties?.attachments);

    const emailAgent = await ensureEmailAgent();
    assert.equal(emailAgent.agentId, EMAIL_MANAGED_AGENT_ID);
    assert.equal(emailAgent.name, 'Email Agent');
    assert.equal(emailAgent.removable, false);
    assert.equal(emailAgent.scopeType, 'system');
    assert.deepEqual(emailAgent.enabledTools, [
      'email_list_mailboxes',
      'email_search_messages',
      'email_read_message',
      'email_list_thread_messages',
      'email_list_cases',
      'email_create_or_update_case',
      'email_create_outbox_draft',
      'email_update_outbox_draft',
      'email_list_outbox_drafts',
      'ls',
      'read',
      'rg',
      'grep',
      'glob',
      'inspect_document_relations',
    ]);
    assert.ok((await listAgentProfiles()).some((agent) => agent.agentId === EMAIL_MANAGED_AGENT_ID));
    assert.deepEqual(await getAgentAccess('owner-user', EMAIL_MANAGED_AGENT_ID), {
      canUse: true, canEdit: true, canManage: true,
    });

    const runtimeUpdated = await updateManagedAgentRuntime({
      actor: { userId: 'owner-user', source: 'system' },
      agentId: EMAIL_MANAGED_AGENT_ID,
      expectedRevision: emailAgent.revision,
      enabledTools: ['email_list_mailboxes', 'write'],
    });
    assert.deepEqual(runtimeUpdated.enabledTools, ['email_list_mailboxes', 'write']);
    assert.equal(
      getProgressiveGatewayCapabilityNames(await getPiTools('owner-user', EMAIL_MANAGED_AGENT_ID)).includes('write'),
      true,
    );
    sqlite.prepare(`UPDATE organization_user_permissions SET role = 'member' WHERE user_id = ?`).run('owner-user');
    await assert.rejects(
      () => updateManagedAgentRuntime({
        actor: { userId: 'owner-user', source: 'system' },
        agentId: EMAIL_MANAGED_AGENT_ID,
        expectedRevision: runtimeUpdated.revision,
        enabledTools: ['email_list_mailboxes'],
      }),
      /Organization owner or admin permission is required/i,
    );

    const seed = await readManagedAgentFile('AGENTS.md', EMAIL_MANAGED_AGENT_ID, { userId: 'owner-user', agentScopeType: 'system' });
    assert.match(seed, /You prepare clear, accurate, and helpful email work/i);
    await writeManagedAgentFile('AGENTS.md', '# Custom Email Agent', EMAIL_MANAGED_AGENT_ID, { userId: 'owner-user', agentScopeType: 'system' });
    assert.equal(await readManagedAgentFile('AGENTS.md', EMAIL_MANAGED_AGENT_ID, { userId: 'owner-user', agentScopeType: 'system' }), '# Custom Email Agent\n');
    assert.match(
      await resetManagedAgentFile('AGENTS.md', EMAIL_MANAGED_AGENT_ID, { userId: 'owner-user', agentScopeType: 'system' }),
      /You prepare clear, accurate, and helpful email work/i,
    );

    const updated = await updateAgentProfile({
      agentId: EMAIL_MANAGED_AGENT_ID,
      name: 'Workspace Mail Agent',
      expectedRevision: runtimeUpdated.revision,
    });
    assert.equal(updated.name, 'Workspace Mail Agent');
    assert.equal(updated.scopeType, 'system');
    await assert.rejects(
      () => deleteAgentProfile(EMAIL_MANAGED_AGENT_ID, updated.revision),
      /Built-in agents cannot be removed/i,
    );
  } finally {
    sqlite.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('email-agent-profile-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
