import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'email-ai-actor-'));
process.env.DATA = root;
process.env.CANVAS_DATA_ROOT = root;
const actorCalls: Array<{ userId: string; workspaceId: string }> = [];
const providerCalls: string[] = [];
const account = { id: 'shared', userId: 'owner', authType: 'smtp_imap', provider: 'smtp_imap', emailAddress: 'support@example.test' };
const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request.endsWith('/email/account-store')) return {
    getEmailAccountForUser: async (userId: string) => { providerCalls.push(userId); assert.equal(userId, 'owner'); return account; },
    readStoredEmailAccountSecret: async () => null,
    publicStoredEmailAccount: () => account,
  };
  if (request.endsWith('/email/imap-service')) return {
    readImapEmailMessage: async (_account: unknown, _id: string, _folder: string, options: { enforceReadPolicy: boolean }) => {
      assert.equal(options.enforceReadPolicy, true);
      return { account, message: { body: 'Shared message', from: 'customer@example.test' } };
    },
  };
  if (request.endsWith('/email/ai-service')) return Object.fromEntries([
    'summarizeEmailWithAi', 'summarizeEmailWithAiStream', 'draftEmailReplyWithAi', 'draftEmailReplyWithAiStream', 'draftEmailComposeWithAi', 'draftEmailComposeWithAiStream',
  ].map(name => [name, async (scope: { userId: string; workspaceId: string }) => { actorCalls.push(scope); return 'fixture'; }]));
  if (['/lib/db', '/lib/db/schema', '/email/attachments', '/email/smtp-service', '/integrations/env-config', '/email/cache/consistency'].some(suffix => request.endsWith(suffix))) return {};
  return originalLoad(request, parent, isMain);
};
async function main() {
  const service = await import('../app/lib/email/local-service');
  const options = { actorUserId: 'member', workspaceId: 'team', enforceReadPolicy: true };
  await service.summarizeLocalEmailMessage('owner', 'shared', 'message', 'INBOX', options);
  await service.streamLocalEmailMessageSummary('owner', 'shared', 'message', 'INBOX', options);
  await service.generateLocalEmailAiReplyBody('owner', 'shared', 'message', 'INBOX', undefined, options);
  await service.streamLocalEmailAiReplyBody('owner', 'shared', 'message', 'INBOX', undefined, options);
  await service.generateLocalEmailComposeBody('owner', { accountId: 'shared', messageId: 'message' }, options);
  await service.streamLocalEmailComposeBody('owner', { accountId: 'shared', messageId: 'message' }, options);
  assert.equal(actorCalls.length, 6);
  assert.ok(providerCalls.length >= 6);
  assert.ok(actorCalls.every(scope => scope.userId === 'member' && scope.workspaceId === 'team'));
  console.log('Email AI preserves the session actor while using shared provider ownership.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { loader._load = originalLoad; rmSync(root, { recursive: true, force: true }); });
