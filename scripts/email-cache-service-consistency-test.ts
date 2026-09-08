import assert from 'node:assert/strict';
import Module from 'node:module';

import {
  setEmailCacheConsistencyStoreFactoryForTests,
} from '../app/lib/email/cache/consistency';
import type { EmailCacheStore } from '../app/lib/email/cache/store';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
type Account = { id: string; provider: string; authType: string; emailAddress: string; isPrimary: boolean; status: string };

const events: Array<{ name: string; accountId?: string; accountSource?: string }> = [];
const localAccount: Account = {
  id: 'shared-account',
  provider: 'google',
  authType: 'oauth',
  emailAddress: 'local@example.test',
  isPrimary: true,
  status: 'active',
};
const managedAccount: Account = {
  id: 'shared-account',
  provider: 'google',
  authType: 'oauth',
  emailAddress: 'managed@example.test',
  isPrimary: true,
  status: 'active',
};

let localAccounts: Account[] = [localAccount];
let managedAvailable = false;
let managedAccounts: Account[] = [];
let nextLocalError: Error | null = null;
let nextDisconnectError: Error | null = null;
let nextManagedDisconnectError: Error | null = null;
let localResultAuthType = 'oauth';

function providerResult(accountId = localAccount.id) {
  return { account: { ...localAccount, id: accountId, authType: localResultAuthType }, ok: true };
}

async function localMutation(name: string) {
  events.push({ name });
  if (nextLocalError) {
    const error = nextLocalError;
    nextLocalError = null;
    throw error;
  }
  return providerResult();
}

const cacheStore = {
  enabled: true,
  async bumpMailboxGeneration(input: { accountId: string; accountSource?: string }) {
    events.push({ name: 'cache:bump', accountId: input.accountId, accountSource: input.accountSource });
    return 2;
  },
  async purgeAccount(input: { accountId: string; accountSource?: string }) {
    events.push({ name: 'cache:purge', accountId: input.accountId, accountSource: input.accountSource });
    return { enabled: true, tombstoned: true, generation: 2, deletedLists: 0, deletedMessages: 0 };
  },
  async reactivateAccount(input: { accountId: string; accountSource?: string }) {
    events.push({ name: 'cache:reactivate', accountId: input.accountId, accountSource: input.accountSource });
    return 3;
  },
} as unknown as EmailCacheStore;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;

moduleInternals._load = function loadWithEmailServiceMocks(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/email/local-service') {
    return {
      archiveLocalEmailMessage: () => localMutation('provider:archive'),
      createLocalEmailAiReplyDraft: () => localMutation('provider:create-ai-draft'),
      createLocalEmailDerivedDraft: () => localMutation('provider:create-derived-draft'),
      createLocalEmailDraft: () => localMutation('provider:create-draft'),
      deleteLocalEmailMessagePermanently: () => localMutation('provider:delete'),
      disconnectLocalEmailAccount: async (_userId: string, accountId: string) => {
        events.push({ name: 'provider:disconnect-local', accountId });
        if (nextDisconnectError) {
          const error = nextDisconnectError;
          nextDisconnectError = null;
          throw error;
        }
        return true;
      },
      listLocalEmailAccounts: async () => localAccounts,
      moveLocalEmailMessage: () => localMutation('provider:move'),
      resolveLocalEmailCacheAccount: async (_userId: string, accountId?: string) => {
        const account = localAccounts.find((candidate) => candidate.id === accountId);
        if (!account) throw new Error('Email account not found.');
        return { account, provider: account.provider };
      },
      sendLocalEmailDerivedMessage: () => localMutation('provider:send-derived'),
      sendLocalEmailDraft: () => localMutation('provider:send-draft'),
      sendLocalEmailMessage: () => localMutation('provider:send-message'),
      setLocalEmailMessageAnswered: () => localMutation('provider:answered'),
      setLocalEmailMessageRead: () => localMutation('provider:read'),
      trashLocalEmailMessage: () => localMutation('provider:trash'),
      updateLocalEmailDraft: () => localMutation('provider:update-draft'),
    };
  }
  if (request === '@/app/lib/email/cache/read-through') {
    return {
      readThroughEmailDetail: async () => { throw new Error('Unexpected detail cache read.'); },
      readThroughEmailList: async () => { throw new Error('Unexpected list cache read.'); },
    };
  }
  if (request === '@/app/lib/email/attachments') return { resolveEmailAttachments: async () => [] };
  if (request === '@/app/lib/email/errors') {
    return { EmailMessageNotFoundError: class EmailMessageNotFoundError extends Error {} };
  }
  if (request === '@/app/lib/email/logging') return { logEmailClientEvent: () => undefined };
  if (request === '@/app/lib/email/managed-client') {
    return {
      getManagedEmailOAuthRedirectUri: () => null,
      isManagedEmailAvailable: () => managedAvailable,
      ManagedEmailRequestError: class ManagedEmailRequestError extends Error {},
      managedEmailRequest: async (path: string, init?: { method?: string }) => {
        if (path === '/v1/managed/email/accounts' && !init) return { accounts: managedAccounts };
        if (init?.method === 'DELETE') {
          events.push({ name: 'provider:disconnect-managed', accountId: path.split('/').at(-1) });
          if (nextManagedDisconnectError) {
            const error = nextManagedDisconnectError;
            nextManagedDisconnectError = null;
            throw error;
          }
          return { success: true };
        }
        throw new Error(`Unexpected managed request: ${path}`);
      },
    };
  }
  if (request === '@/app/lib/email/smtp-service') {
    return {
      saveSmtpEmailAccount: async () => {
        events.push({ name: 'provider:save-smtp' });
        return { ...localAccount, id: 'smtp-account', provider: 'smtp_imap', authType: 'smtp_imap' };
      },
      testSmtpConnection: async () => ({ ok: true }),
      testStoredSmtpEmailAccount: async () => ({ ok: true }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  setEmailCacheConsistencyStoreFactoryForTests(async () => cacheStore);
  try {
    const service = await import('../app/lib/email/service');

    const actions: Array<[string, () => Promise<unknown>]> = [
      ['provider:read', () => service.setEmailMessageRead('user-1', localAccount.id, 'message-1', 'INBOX', true)],
      ['provider:answered', () => service.setEmailMessageAnswered('user-1', localAccount.id, 'message-1', 'INBOX', true)],
      ['provider:archive', () => service.archiveEmailMessage('user-1', localAccount.id, 'message-1', 'INBOX')],
      ['provider:move', () => service.moveEmailMessage('user-1', localAccount.id, 'message-1', 'INBOX', 'Archive')],
      ['provider:trash', () => service.trashEmailMessage('user-1', localAccount.id, 'message-1', 'INBOX')],
      ['provider:delete', () => service.deleteEmailMessagePermanently('user-1', localAccount.id, 'message-1', 'INBOX')],
    ];
    for (const [providerEvent, action] of actions) {
      events.length = 0;
      await action();
      assert.deepEqual(events, [
        { name: providerEvent },
        { name: 'cache:bump', accountId: localAccount.id, accountSource: 'local' },
      ]);
    }

    events.length = 0;
    nextLocalError = new Error('provider failed');
    await assert.rejects(actions[0][1], /provider failed/u);
    assert.deepEqual(events, [{ name: 'provider:read' }]);

    events.length = 0;
    const mailboxChanged = Object.assign(new Error('The IMAP mailbox changed.'), {
      code: 'EMAIL_MAILBOX_CHANGED',
      status: 409,
    });
    nextLocalError = mailboxChanged;
    await assert.rejects(actions[0][1], (error) => error === mailboxChanged);
    assert.deepEqual(events, [
      { name: 'provider:read' },
      { name: 'cache:bump', accountId: localAccount.id, accountSource: 'local' },
    ]);

    events.length = 0;
    localAccounts = [localAccount];
    managedAvailable = true;
    managedAccounts = [managedAccount];
    await service.disconnectEmailAccount('user-1', localAccount.id);
    assert.deepEqual(events, [
      { name: 'provider:disconnect-local', accountId: localAccount.id },
      { name: 'cache:purge', accountId: localAccount.id, accountSource: 'local' },
    ]);

    events.length = 0;
    nextDisconnectError = new Error('disconnect failed');
    await assert.rejects(service.disconnectEmailAccount('user-1', localAccount.id), /disconnect failed/u);
    assert.deepEqual(events, [{ name: 'provider:disconnect-local', accountId: localAccount.id }]);

    events.length = 0;
    localAccounts = [];
    await service.disconnectEmailAccount('user-1', managedAccount.id);
    assert.deepEqual(events, [
      { name: 'provider:disconnect-managed', accountId: managedAccount.id },
      { name: 'cache:purge', accountId: managedAccount.id, accountSource: 'managed' },
    ]);

    events.length = 0;
    nextManagedDisconnectError = new Error('managed disconnect failed');
    await assert.rejects(service.disconnectEmailAccount('user-1', managedAccount.id), /managed disconnect failed/u);
    assert.deepEqual(events, [{ name: 'provider:disconnect-managed', accountId: managedAccount.id }]);

    events.length = 0;
    await service.listEmailAccounts('user-1');
    assert.equal(events.some((event) => event.name === 'cache:reactivate'), false);

    events.length = 0;
    nextLocalError = new Error('Email account not found.');
    await assert.rejects(
      service.setEmailMessageRead('user-1', managedAccount.id, 'message-1', 'INBOX', true),
      /not found/u,
    );
    assert.equal(events.some((event) => event.name.startsWith('cache:')), false);

    events.length = 0;
    managedAccounts = [];
    await assert.rejects(service.disconnectEmailAccount('user-1', managedAccount.id), /not found/u);
    assert.equal(events.some((event) => event.name.startsWith('cache:')), false);

    events.length = 0;
    managedAvailable = false;
    localAccounts = [localAccount];
    await service.saveEmailSmtpAccount('user-1', { emailAddress: 'smtp@example.test' });
    assert.deepEqual(events, [
      { name: 'provider:save-smtp' },
      { name: 'cache:reactivate', accountId: 'smtp-account', accountSource: 'local' },
    ]);

    const draftInput = { accountId: localAccount.id, to: [], subject: '', body: '' };
    localResultAuthType = 'oauth';
    const localMailboxWrites: Array<[string, () => Promise<unknown>]> = [
      ['provider:create-derived-draft', () => service.createEmailDerivedDraft('user-1', localAccount.id, 'message-1', 'INBOX', 'reply')],
      ['provider:send-derived', () => service.sendEmailDerivedMessage('user-1', localAccount.id, 'message-1', 'INBOX', 'reply')],
      ['provider:create-ai-draft', () => service.createEmailAiReplyDraft('user-1', localAccount.id, 'message-1', 'INBOX')],
      ['provider:create-draft', () => service.createEmailDraft('user-1', draftInput)],
      ['provider:update-draft', () => service.updateEmailDraft('user-1', 'draft-1', draftInput)],
      ['provider:send-message', () => service.sendEmailMessage('user-1', draftInput)],
      ['provider:send-draft', () => service.sendEmailDraft('user-1', localAccount.id, 'draft-1')],
    ];
    for (const [providerEvent, write] of localMailboxWrites) {
      events.length = 0;
      await write();
      assert.deepEqual(events, [
        { name: providerEvent },
        { name: 'cache:bump', accountId: localAccount.id, accountSource: 'local' },
      ]);
    }

    events.length = 0;
    localResultAuthType = 'smtp_imap';
    await service.createEmailDraft('user-1', draftInput);
    assert.deepEqual(events, [{ name: 'provider:create-draft' }]);

    console.log('email-cache-service-consistency-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    setEmailCacheConsistencyStoreFactoryForTests(null);
  }
}

main().catch((error) => {
  moduleInternals._load = originalLoad;
  setEmailCacheConsistencyStoreFactoryForTests(null);
  console.error(error);
  process.exitCode = 1;
});
