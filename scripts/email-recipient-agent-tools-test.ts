import assert from 'node:assert/strict';
import Module from 'node:module';
import { createPiTestDatabase } from './helpers/pi-test-database';

let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
let canRunAgent = true;
let discoveryData: unknown = { status: 'resolved', candidates: [], coverage: { incomplete: false } };
const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
const internal = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = internal._load;
internal._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/pi/tool-runtime-helpers') return { getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) };
  if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async (input: Record<string, unknown>) => {
    assert.equal(input.userId, 'viewer'); assert.equal(input.workspaceId, 'mail-workspace');
    assert.deepEqual(input.permissions, ['canRead', 'canRunAgent']);
    if (!canRunAgent) throw new Error('Agent permission removed.');
  } };
  if (request === '@/app/lib/email/account-store') return { getEmailAccountForUser: async (userId: string, accountId: string) => {
    assert.equal(userId, 'viewer'); assert.equal(accountId, 'personal');
    return { id: 'personal', emailAddress: 'viewer@example.test', accountScope: 'personal' };
  } };
  if (request === '@/app/lib/email/recipient-discovery') return {
    findEmailRecipients: async (input: Record<string, unknown>) => { calls.push({ operation: 'find', input }); return discoveryData; },
    suggestEmailReplyRecipients: async (input: Record<string, unknown>) => { calls.push({ operation: 'reply', input }); return discoveryData; },
  };
  if (['@/app/lib/email/service', '@/app/lib/email/attachments', '@/app/lib/email/workspace-inbox-outbox', '@/app/lib/email/attachment-batch', '@/app/lib/email/attachment-workspace-save'].includes(request)) return {};
  return originalLoad(request, parent, isMain);
};

function text(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

async function main() {
  database = await createPiTestDatabase();
  const { user, emailAccounts, workspaceEmailMailboxes } = await import('../app/lib/db/schema');
  const { createEmailAgentTools } = await import('../app/lib/pi/workspace-email-tools');
  const { collapseProgressiveToolGroups, getProgressiveGatewayCapabilityNames, replaceProgressiveToolOperations, withAllowedProgressiveGatewayOperations } = await import('../app/lib/pi/progressive-tool-gateway');
  const { EMAIL_AGENT_ALLOWED_TOOL_NAME_SET, filterToolsToAllowedNames } = await import('../app/lib/pi/email-agent-policy');
  const { resolveEnabledToolNames } = await import('../app/lib/pi/enabled-tools');
  const { buildEffectiveToolManifest, buildEffectiveToolCapabilitiesPrompt, effectiveToolManifestHas } = await import('../app/lib/pi/effective-tool-manifest');
  const { getPiToolsetsForTool } = await import('../app/lib/pi/toolsets');
  const now = new Date();
  await database.db.insert(user).values(['owner', 'viewer'].map(id => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
  await database.db.insert(emailAccounts).values([
    { id: 'work', userId: 'owner', accountScope: 'workspace' }, { id: 'personal', userId: 'viewer', accountScope: 'personal' },
  ].map(account => ({ ...account, provider: 'google', authType: 'oauth', emailAddress: `${account.id}@example.test`, secretRef: 'fixture', policyJson: '{}', status: 'active', createdAt: now, updatedAt: now })));
  await database.db.insert(workspaceEmailMailboxes).values({ id: 'mailbox-work', workspaceId: 'mail-workspace', emailAccountId: 'work', createdByUserId: 'owner', lastEditedByUserId: 'owner', createdAt: now, updatedAt: now });
  const direct = createEmailAgentTools({ userId: 'viewer', workspaceId: 'chat-workspace' });
  const grouped = collapseProgressiveToolGroups(direct);
  const gateway = grouped.find(tool => tool.name === 'email_recipients')!;
  assert.ok(gateway);
  assert.equal(grouped.some(tool => tool.name === 'email_find_recipients'), false);
  assert.equal(grouped.some(tool => tool.name === 'email_read_message'), true, 'Existing email tools remain direct');
  const searched = await gateway.execute('search', { action: 'search', query: 'recipients' });
  assert.match(text(searched), /email_find_recipients/u); assert.match(text(searched), /email_suggest_reply_recipients/u);
  assert.doesNotMatch(text(searched), /Input schema|"properties"/u);
  const described = await gateway.execute('describe', { action: 'describe', operation: 'email_find_recipients' });
  assert.match(text(described), /Input schema/u); assert.match(text(described), /"query"/u);
  assert.doesNotMatch(text(described), /"messageId"|email_suggest_reply_recipients/u);
  const directDiscovery = direct.filter(tool => tool.name === 'email_find_recipients' || tool.name === 'email_suggest_reply_recipients');
  const declaration = (tool: typeof gateway) => ({ name: tool.name, description: tool.description, parameters: tool.parameters });
  assert.ok(JSON.stringify([declaration(gateway)]).length < JSON.stringify(directDiscovery.map(declaration)).length * 0.75, 'Default gateway schemas materially shrink compared with both direct operation schemas');
  assert.deepEqual(getPiToolsetsForTool('email_find_recipients'), ['email']);
  assert.deepEqual(getPiToolsetsForTool('email_suggest_reply_recipients'), ['email']);
  assert.deepEqual(getPiToolsetsForTool('email_recipients'), ['email']);

  const manifest = buildEffectiveToolManifest(grouped);
  const prompt = buildEffectiveToolCapabilitiesPrompt(manifest);
  assert.equal(manifest.tools.some(tool => tool.name === 'email_find_recipients'), false);
  assert.match(prompt, /Look up names in the selected mailbox/u); assert.match(prompt, /incomplete coverage never proves a unique identity/u);
  assert.doesNotMatch(buildEffectiveToolCapabilitiesPrompt(buildEffectiveToolManifest([])), /recipient research|Look up names/u);
  const customNames = resolveEnabledToolNames(getProgressiveGatewayCapabilityNames(grouped), ['email_find_recipients']);
  const restricted = withAllowedProgressiveGatewayOperations(gateway, customNames)!;
  assert.deepEqual(getProgressiveGatewayCapabilityNames([restricted]), ['email_find_recipients']);
  assert.equal(effectiveToolManifestHas(buildEffectiveToolManifest([restricted]), 'email_suggest_reply_recipients'), false);
  assert.doesNotMatch(buildEffectiveToolCapabilitiesPrompt(buildEffectiveToolManifest([restricted])), /Reply suggestions use/u);
  const denied = await restricted.execute('denied', { action: 'call', operation: 'email_suggest_reply_recipients', arguments: {} });
  assert.match(text(denied), /not available/u); assert.equal(calls.length, 0);
  const invalid = await restricted.execute('invalid', { action: 'call', operation: 'email_find_recipients', arguments: { mailboxId: 'account:personal', query: 'x'.repeat(121) } });
  assert.match(text(invalid), /Invalid arguments/u); assert.equal(calls.length, 0);
  await gateway.execute('personal', { action: 'call', operation: 'email_find_recipients', arguments: { mailboxId: 'account:personal', query: 'Anna', purpose: 'human', actorUserId: 'victim' } });
  assert.equal(calls[0].input.actorUserId, 'viewer'); assert.equal(calls[0].input.purpose, 'agent');
  assert.equal(calls[0].input.accountId, 'personal'); assert.equal(calls[0].input.mailboxWorkspaceId, null);

  const boundOperations = createEmailAgentTools({ userId: 'viewer', workspaceId: 'mail-workspace', bindings: { mailboxId: 'mailbox-work', providerMessageId: 'trigger-message', providerThreadId: null, folder: 'INBOX' } });
  const bound = filterToolsToAllowedNames(replaceProgressiveToolOperations([restricted], boundOperations), EMAIL_AGENT_ALLOWED_TOOL_NAME_SET)[0];
  assert.deepEqual(getProgressiveGatewayCapabilityNames([bound]), ['email_find_recipients'], 'Mailbox rebinding and event ceiling preserve custom operation restrictions');
  await bound.execute('bound', { action: 'call', operation: 'email_find_recipients', arguments: { mailboxId: 'account:personal', mailboxWorkspaceId: 'other-workspace', query: 'Anna', purpose: 'human', actorUserId: 'victim' } });
  assert.equal(calls.at(-1)?.input.actorUserId, 'viewer'); assert.equal(calls.at(-1)?.input.purpose, 'agent');
  assert.equal(calls.at(-1)?.input.accountId, 'work'); assert.equal(calls.at(-1)?.input.mailboxWorkspaceId, 'mail-workspace');
  assert.equal(calls.at(-1)?.input.folder, 'INBOX');
  const bothBound = replaceProgressiveToolOperations([gateway], boundOperations)[0];
  await bothBound.execute('reply', { action: 'call', operation: 'email_suggest_reply_recipients', arguments: { mailboxId: 'account:personal', mailboxWorkspaceId: 'other-workspace' } });
  assert.equal(calls.at(-1)?.input.messageId, 'trigger-message'); assert.equal(calls.at(-1)?.input.accountId, 'work');
  canRunAgent = false;
  const before = calls.length;
  assert.match(text(await bound.execute('revoked', { action: 'call', operation: 'email_find_recipients', arguments: { query: 'Anna' } })), /permission removed/u);
  assert.equal(calls.length, before); canRunAgent = true;

  discoveryData = { status: 'ambiguous', candidates: [], sourceEvidence: 'x'.repeat(7_300) };
  const bounded = await gateway.execute('bounded', { action: 'call', operation: 'email_find_recipients', arguments: { mailboxId: 'account:personal', query: 'Anna' } });
  assert.ok(text(bounded).length < 8_000); assert.match(text(bounded), /^SECURITY NOTICE/u);
  assert.deepEqual(JSON.parse(text(bounded).split('\n\n')[1]), discoveryData, 'Bounded data stays compact and complete JSON');
  discoveryData = { overflow: 'x'.repeat(8_000) };
  const overflow = await gateway.execute('overflow', { action: 'call', operation: 'email_find_recipients', arguments: { mailboxId: 'account:personal', query: 'Anna' } });
  assert.ok(text(overflow).length < 8_000); assert.match(text(overflow), /too much data/u);
  console.log('Recipient agent gateway: progressive schemas, capability guidance, custom restrictions, bound mailbox permissions and compact result budget passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { internal._load = originalLoad; await database?.close(); });
