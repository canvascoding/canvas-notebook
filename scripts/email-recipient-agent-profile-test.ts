import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
const internal = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = internal._load;
internal._load = (request, parent, isMain) => {
  if (request === 'server-only' || request === '@/app/lib/pi/session-deletion') return {};
  if (request === '@/app/lib/db') return database;
  return originalLoad(request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  const { agents } = await import('../app/lib/db/schema');
  const { ensureEmailAgent } = await import('../app/lib/agents/registry');
  const { EMAIL_AGENT_DEFAULT_ENABLED_TOOLS } = await import('../app/lib/pi/email-agent-policy');
  const beforeDiscovery = ['email_list_mailboxes', 'email_search_messages', 'email_read_message', 'email_download_attachment',
    'email_list_thread_messages', 'email_list_cases', 'email_create_or_update_case', 'email_create_outbox_draft',
    'email_update_outbox_draft', 'email_list_outbox_drafts', 'ls', 'read', 'rg', 'grep', 'glob', 'inspect_document_relations'];
  const created = await ensureEmailAgent();
  assert.deepEqual(created.enabledTools, EMAIL_AGENT_DEFAULT_ENABLED_TOOLS);
  await database.db.update(agents).set({ enabledToolsJson: JSON.stringify(beforeDiscovery), revision: 4 }).where(eq(agents.agentId, 'email-agent'));
  const migrated = await ensureEmailAgent();
  assert.deepEqual(migrated.enabledTools, EMAIL_AGENT_DEFAULT_ENABLED_TOOLS);
  const custom = ['email_read_message', 'email_find_recipients', 'read'];
  await database.db.update(agents).set({ enabledToolsJson: JSON.stringify(custom) }).where(eq(agents.agentId, 'email-agent'));
  assert.deepEqual((await ensureEmailAgent()).enabledTools, custom, 'Custom selections never gain undisclosed tools');
  await database.db.update(agents).set({ enabledToolsJson: '["__none__"]' }).where(eq(agents.agentId, 'email-agent'));
  assert.deepEqual((await ensureEmailAgent()).enabledTools, ['__none__']);
  console.log('Email recipient agent profile: current prior defaults migrate; custom and disabled selections persist.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { internal._load = originalLoad; await database?.close(); });
