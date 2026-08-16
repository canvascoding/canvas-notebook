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
    const { readManagedAgentFile, resetManagedAgentFile, writeManagedAgentFile } = await import('../app/lib/agents/storage');

    const emailAgent = await ensureEmailAgent();
    assert.equal(emailAgent.agentId, EMAIL_MANAGED_AGENT_ID);
    assert.equal(emailAgent.name, 'Email Agent');
    assert.equal(emailAgent.removable, false);
    assert.equal(emailAgent.scopeType, 'system');
    assert.deepEqual(emailAgent.enabledTools, [
      'email_list_accounts',
      'email_search',
      'email_read',
      'email_create_draft',
      'email_update_draft',
      'workspace_email_list_mailboxes',
      'workspace_email_search_messages',
      'workspace_email_read_message',
      'workspace_email_list_thread_messages',
      'workspace_email_list_cases',
      'workspace_email_create_or_update_case',
      'workspace_email_create_outbox_draft',
      'workspace_email_update_outbox_draft',
      'workspace_email_list_outbox_drafts',
    ]);
    assert.ok((await listAgentProfiles()).some((agent) => agent.agentId === EMAIL_MANAGED_AGENT_ID));
    assert.deepEqual(await getAgentAccess('owner-user', EMAIL_MANAGED_AGENT_ID), {
      canUse: true, canEdit: true, canManage: true,
    });

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
      expectedRevision: emailAgent.revision,
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
