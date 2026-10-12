import assert from 'node:assert/strict';
import Module from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import type { StoredEmailAccount } from '../app/lib/email/account-store';
import type { EmailAccountSmtpSecret } from '../app/lib/email/secret-store';
import type { AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';
import type { PostgresEmailClassificationStore } from '../app/lib/email/classification/store';
import type { EmailClassificationQueryable, EmailClassificationMetadataInput } from '../app/lib/email/classification/store-types';
import type { AcceptedEmailReplyInput } from '../app/lib/email/accepted-reply';
import type { ImapClientLike } from '../app/lib/email/imap-service';

const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = loader._load;
let store: PostgresEmailClassificationStore;
let runtimePostgres: PGlite;
let source: AuthorizedEmailClassificationMailbox;
let account: StoredEmailAccount;
let secret: EmailAccountSmtpSecret;
let registryFails = false;
let flagFails = false;
let storageFails = false;
let transportFails = false;
let mutateDuringSend: (() => Promise<void>) | undefined;
let transportCalls = 0;
let providerFlags = 0;
let invalidations = 0;
let registryActors: string[] = [];
const connectionHosts: string[] = [];
let uidValidity = '9';

function publicAccount() { return { id: account.id, provider: account.provider, authType: account.authType, emailAddress: account.emailAddress }; }
async function delivered() {
  transportCalls++;
  if (mutateDuringSend) await mutateDuringSend();
  if (transportFails) throw new Error('Synthetic transport uncertainty');
  return { account: publicAccount(), sent: true, messageId: 'outgoing-id' };
}
loader._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?\.ts$/u.test(request)) {
    const query = async (sql: string, params?: unknown[]) => { if (storageFails) throw new Error('Synthetic classification outage'); return runtimePostgres.query(sql, params); };
    return { db: { query: { emailAccounts: { findFirst: async () => account } } }, assertDatabaseAvailable: () => {},
      getPostgresRuntimeQueryable: () => ({ query, connect: async () => ({ query, release: () => {} }) }) };
  }
  if (request === '@/app/lib/email/account-store' || request.endsWith('/email/account-store.ts')) return {
    getEmailAccountForUser: async () => structuredClone(account), readStoredEmailAccountSecret: async () => structuredClone(secret),
    publicStoredEmailAccount: () => publicAccount(),
  };
  if (request.endsWith('/email/classification/mailbox-registry.ts')) return {
    resolveAuthorizedEmailClassificationMailboxes: async (actor: string) => { registryActors.push(actor); if (registryFails) throw new Error('Synthetic source outage'); return [structuredClone(source)]; },
  };
  if (request === '@/app/lib/email/local-service') return {
    sendLocalEmailDerivedMessage: delivered, createLocalEmailDerivedDraft: async () => ({ account: publicAccount(), draft: { id: 'draft', status: 'prepared' } }),
    listLocalEmailAccounts: async () => [publicAccount()],
  };
  if (request === '@/app/lib/email/managed-client') return { isManagedEmailAvailable: () => false, ManagedEmailRequestError: class extends Error {} };
  if (request === '@/app/lib/email/smtp-service') return {};
  if (request === '@/app/lib/email/logging') return { logEmailClientEvent: () => {} };
  if (request === '@/app/lib/email/cache/consistency' || request.endsWith('/email/cache/consistency.ts')) return {
    invalidateEmailMailboxCache: async () => { invalidations++; },
  };
  if (request === '@/app/lib/email/mailbox-access') return {
    EmailMailboxAccessError: class extends Error {}, resolveEmailMailboxAccess: async (input: { mailboxWorkspaceId?: string }) => ({
      accountId: account.id, accountOwnerId: 'owner', workspaceId: input.mailboxWorkspaceId ?? null, mailboxId: input.mailboxWorkspaceId ? 'binding' : null,
      readOptions: { enforceReadPolicy: false, cacheMode: 'provider' },
    }),
  };
  if (request === '@/app/lib/email/workspace-inbox-outbox') return {
    createWorkspaceOutboxDraft: async () => ({ id: 'outbox', version: 1, status: 'prepared' }),
    sendWorkspaceOutboxDraft: async () => { await delivered(); return { id: 'outbox', version: 2, status: 'sent' }; },
  };
  if (request === '@/app/lib/email/attachments') return { snapshotBrowserEmailAttachments: async () => [], resolveEmailAttachments: async () => [], BrowserEmailAttachmentError: class extends Error {} };
  // Shared derived read goes through the real mailbox compose flow without network/body storage.
  if (request === '@/app/lib/email/service' && parent?.filename.endsWith('mailbox-compose.ts')) return {
    readEmailMessage: async () => ({ message: { from: 'customer@example.test', to: ['owner@example.test'], subject: 'Question', body: 'Original synthetic email' } }),
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { runEmailClassificationPostgresMigration } = await import('../app/lib/email/classification/postgres-migration');
  const { createEmailClassificationStore } = await import('../app/lib/email/classification/store');
  const { emailClassificationFingerprint, emailClassificationMailboxRef, emailClassificationMessageIdentity } = await import('../app/lib/email/classification/identity');
  const { setImapClientFactoryForTests, createImapMessageReference } = await import('../app/lib/email/imap-service');
  const { captureAcceptedEmailReply, recordAcceptedEmailReply } = await import('../app/lib/email/accepted-reply');
  const service = await import('../app/lib/email/service');
  const { createBrowserEmailDerivedDraft } = await import('../app/lib/email/mailbox-compose');
  const postgres = new PGlite();
  runtimePostgres = postgres;
  await postgres.exec(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES ('owner'), ('member');`);
  await runEmailClassificationPostgresMigration(postgres);
  store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable,
    transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
  setImapClientFactoryForTests(snapshot => {
    connectionHosts.push(snapshot.imap!.host);
    return { mailbox: { uidValidity }, connect: async () => {}, logout: async () => {}, close: () => {},
      getMailboxLock: async () => ({ release() {} }),
      messageFlagsAdd: async (uids: number[], flags: string[]) => {
        assert.deepEqual(uids, [1]); assert.deepEqual(flags, ['\\Answered']);
        if (flagFails) throw new Error('Synthetic IMAP flag outage'); providerFlags++; return true;
      },
    } as unknown as ImapClientLike;
  });
  let serial = 0;
  async function fixture(work = false, oauth = false) {
    registryFails = flagFails = storageFails = transportFails = false; mutateDuringSend = undefined;
    transportCalls = providerFlags = invalidations = 0; registryActors = []; connectionHosts.length = 0; uidValidity = '9';
    const accountId = `account-${++serial}`;
    account = { id: accountId, userId: 'owner', provider: oauth ? 'google' : 'smtp_imap', authType: oauth ? 'oauth' : 'smtp_imap',
      accountScope: work ? 'workspace' : 'personal', emailAddress: 'owner@example.test', displayName: null, status: 'active', isPrimary: true,
      createdAt: new Date(1_000), updatedAt: new Date(1_000), providerAccountId: null } as StoredEmailAccount;
    secret = { authType: 'smtp_imap', smtp: { host: 'smtp.original.test', port: 587, secure: false, username: 'owner', password: 'synthetic' },
      imap: { host: 'imap.original.test', port: 993, secure: true, username: 'owner', password: 'synthetic' } };
    const descriptor = { ownerUserId: 'owner', accountId, accountSource: 'local' as const, provider: oauth ? 'google' : 'imap',
      workspaceId: work ? 'workspace' : null, mailboxId: work ? 'binding' : null,
      connectionRevision: emailClassificationFingerprint(['owner', 'local', accountId, work ? 'workspace' : null, work ? 'binding' : null,
        account.provider, account.authType, 1_000, null, account.emailAddress, ...(oauth ? [null, null, null, null] : ['imap.original.test', 993, 'owner', true])]),
      bindingRevision: 'binding-1', policyRevision: 'policy-1', active: true,
      readFrom: [], emailAddress: 'owner@example.test', displayName: null, workspaceName: null,
      capabilities: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManage: true } };
    source = { ...descriptor, mailboxRef: emailClassificationMailboxRef(descriptor) };
    const messageId = oauth ? 'oauth-original' : createImapMessageReference('INBOX', '9', 1);
    const identity = emailClassificationMessageIdentity(source, { id: messageId, folder: 'INBOX' });
    const metadata: EmailClassificationMetadataInput = { mailboxRef: source.mailboxRef, messageRef: identity.messageRef,
      canonicalId: identity.canonicalId, folder: identity.folder, replyStatus: 'unanswered', dateTimestamp: 1, fingerprint: 'content',
      list: { from: 'customer@example.test', subject: 'Question', date: '1970-01-01T00:00:00.001Z', snippet: 'Please reply' } };
    await store.upsertMailbox(source, 1); await store.upsertMessageMetadata(metadata, 2);
    const input: AcceptedEmailReplyInput = { actorUserId: work ? 'member' : 'owner', ownerUserId: 'owner', accountId,
      workspaceId: source.workspaceId, accountSource: 'local', messageId, folder: 'INBOX', mode: 'reply' };
    const status = async () => (await store.readMessages([identity.messageRef]))[0]?.replyStatus;
    return { input, metadata, status };
  }
  try {
    const personal = await fixture();
    const prepared = await captureAcceptedEmailReply(personal.input);
    assert.ok(prepared?.imap, 'The real helper must capture its injected source and original IMAP snapshot');
    const accepted = await service.sendEmailDerivedMessage('owner', account.id, personal.input.messageId, 'INBOX', 'reply');
    assert.equal(accepted.sent, true); assert.equal(transportCalls, 1); assert.equal(providerFlags, 1);
    assert.equal(await personal.status(), 'answered'); assert.equal(invalidations, 1);
    const acceptedColumn = (await postgres.query<{ accepted_reply_at: number }>('SELECT accepted_reply_at FROM email_classification_messages WHERE message_ref=$1', [personal.metadata.messageRef])).rows[0].accepted_reply_at;
    assert.ok(acceptedColumn > 0);
    const revision = (await store.readMessages([personal.metadata.messageRef]))[0].indexRevision;
    await store.upsertMessageMetadata(personal.metadata, 3);
    assert.equal(await personal.status(), 'answered', 'later real IMAP false does not erase app-confirmed accepted reply evidence');
    assert.equal((await store.readMessages([personal.metadata.messageRef]))[0].indexRevision, revision, 'unchanged provider false does not churn snapshot revisions');
    await store.updateIndexedMessageState({ ownerUserId: 'owner', accountId: account.id, accountSource: 'local', canonicalId: personal.metadata.canonicalId, answered: false });
    assert.equal(await personal.status(), 'unanswered', 'explicit clear-answered removes accepted proof');
    assert.equal((await postgres.query<{ accepted_reply_at: number | null }>('SELECT accepted_reply_at FROM email_classification_messages WHERE message_ref=$1', [personal.metadata.messageRef])).rows[0].accepted_reply_at, null);

    const all = await fixture();
    await service.sendEmailDerivedMessage('owner', account.id, all.input.messageId, 'INBOX', 'reply-all');
    assert.equal(await all.status(), 'answered'); assert.equal(providerFlags, 1);
    for (const mode of ['forward', 'draft', 'failed'] as const) {
      const inactive = await fixture();
      if (mode === 'forward') await service.sendEmailDerivedMessage('owner', account.id, inactive.input.messageId, 'INBOX', 'forward');
      else if (mode === 'draft') await service.createEmailDerivedDraft('owner', account.id, inactive.input.messageId, 'INBOX', 'reply');
      else { transportFails = true; await assert.rejects(service.sendEmailDerivedMessage('owner', account.id, inactive.input.messageId, 'INBOX', 'reply')); }
      assert.equal(await inactive.status(), 'unanswered', `${mode} never marks original answered`); assert.equal(providerFlags, 0);
    }
    const oauth = await fixture(false, true);
    await service.sendEmailDerivedMessage('owner', account.id, oauth.input.messageId, 'INBOX', 'reply');
    assert.equal(await oauth.status(), 'answered', 'accepted OAuth reply provides local evidence without unsupported provider flags'); assert.equal(providerFlags, 0);

    const flagFailure = await fixture(); flagFails = true;
    assert.equal((await service.sendEmailDerivedMessage('owner', account.id, flagFailure.input.messageId, 'INBOX', 'reply')).sent, true);
    assert.equal(transportCalls, 1); assert.equal(await flagFailure.status(), 'answered', 'IMAP bookkeeping failure does not lose accepted-send evidence or suggest resend');
    const storeFailure = await fixture(); storageFails = true;
    assert.equal((await service.sendEmailDerivedMessage('owner', account.id, storeFailure.input.messageId, 'INBOX', 'reply')).sent, true);
    assert.equal(transportCalls, 1); assert.equal(providerFlags, 1);
    const preparationFailure = await fixture(); registryFails = true;
    assert.equal((await service.sendEmailDerivedMessage('owner', account.id, preparationFailure.input.messageId, 'INBOX', 'reply')).sent, true);
    assert.equal(transportCalls, 1); assert.equal(await preparationFailure.status(), 'unanswered');

    const rebinding = await fixture();
    const captured = await captureAcceptedEmailReply(rebinding.input); assert.ok(captured);
    source = { ...source, connectionRevision: 'connection-2' };
    secret.imap!.host = 'imap.other-mailbox.test';
    await store.upsertMailbox(source, 4);
    await recordAcceptedEmailReply(captured, true);
    assert.equal(providerFlags, 0); assert.deepEqual(connectionHosts, [], 'rebound source must never receive the old canonical ID');
    assert.equal(await store.confirmAcceptedReply({ mailboxRef: captured.source.mailboxRef, messageRef: captured.messageRef,
      connectionRevision: captured.source.connectionRevision, bindingRevision: captured.source.bindingRevision, policyRevision: captured.source.policyRevision }), false);
    for (const changed of ['bindingRevision', 'policyRevision'] as const) {
      const stale = await fixture(); const old = await captureAcceptedEmailReply(stale.input); assert.ok(old);
      source = { ...source, [changed]: 'changed' }; await store.upsertMailbox(source, 5);
      await recordAcceptedEmailReply(old, true);
      assert.equal(providerFlags, 0); assert.equal(await stale.status(), 'unanswered');
      assert.equal(await store.confirmAcceptedReply({ mailboxRef: old.source.mailboxRef, messageRef: old.messageRef,
        connectionRevision: old.source.connectionRevision, bindingRevision: old.source.bindingRevision, policyRevision: old.source.policyRevision }), false);
    }
    const revoked = await fixture(); const revokedCapture = await captureAcceptedEmailReply(revoked.input);
    source.capabilities.canWrite = false;
    await recordAcceptedEmailReply(revokedCapture, true); assert.equal(providerFlags, 0); assert.equal(await revoked.status(), 'unanswered');

    const pinned = await fixture(); const pinnedCapture = await captureAcceptedEmailReply(pinned.input);
    secret.imap!.host = 'changed-after-capture.test';
    await recordAcceptedEmailReply(pinnedCapture, true);
    assert.deepEqual(connectionHosts, ['imap.original.test'], 'provider flag uses the original in-memory credential snapshot');
    const inconsistent = await fixture(); secret.imap!.host = 'intervening-mailbox.test';
    const inconsistentCapture = await captureAcceptedEmailReply(inconsistent.input);
    assert.ok(inconsistentCapture); assert.equal(inconsistentCapture.imap, undefined, 'snapshot identity must match the original source connection hash');
    await recordAcceptedEmailReply(inconsistentCapture, true);
    assert.equal(providerFlags, 0); assert.equal(await inconsistent.status(), 'answered', 'a mismatched snapshot blocks provider writes while retaining valid CAS accepted evidence');
    const staleUid = await fixture(); const staleUidCapture = await captureAcceptedEmailReply(staleUid.input); uidValidity = '10';
    await recordAcceptedEmailReply(staleUidCapture, true);
    assert.equal(providerFlags, 0, 'UIDVALIDITY prevents flagging another message after mailbox reset'); assert.equal(await staleUid.status(), 'answered');
    const uncertain = await fixture(); const uncertainCapture = await captureAcceptedEmailReply(uncertain.input);
    await recordAcceptedEmailReply(uncertainCapture, false); assert.equal(providerFlags, 0); assert.equal(await uncertain.status(), 'unanswered');

    const work = await fixture(true);
    const shared = await createBrowserEmailDerivedDraft('member', { accountId: account.id, mailboxWorkspaceId: 'workspace',
      messageId: work.input.messageId, folder: 'INBOX', mode: 'reply' }, true);
    assert.ok(shared !== null && typeof shared === 'object' && !Array.isArray(shared) && 'status' in shared);
    assert.equal(shared.status, 'sent'); assert.equal(transportCalls, 1);
    assert.equal(await work.status(), 'answered'); assert.equal(providerFlags, 1);
    assert.ok(registryActors.every(actor => actor === 'member'), 'shared reply revalidates actor access, not owner permissions');
    const workDraft = await fixture(true);
    await createBrowserEmailDerivedDraft('member', { accountId: account.id, mailboxWorkspaceId: 'workspace', messageId: workDraft.input.messageId, mode: 'reply' }, false);
    assert.equal(await workDraft.status(), 'unanswered'); assert.equal(providerFlags, 0); assert.equal(transportCalls, 0);
    const workFailed = await fixture(true); transportFails = true;
    await assert.rejects(createBrowserEmailDerivedDraft('member', { accountId: account.id, mailboxWorkspaceId: 'workspace', messageId: workFailed.input.messageId, mode: 'reply' }, true));
    assert.equal(await workFailed.status(), 'unanswered'); assert.equal(providerFlags, 0);

    await postgres.exec('ALTER TABLE email_classification_messages DROP COLUMN accepted_reply_at');
    await runEmailClassificationPostgresMigration(postgres); await runEmailClassificationPostgresMigration(postgres);
    assert.equal((await postgres.query("SELECT column_name FROM information_schema.columns WHERE table_name='email_classification_messages' AND column_name='accepted_reply_at'")).rows.length, 1, 'additive migration upgrades old installs idempotently');
    console.log('Accepted email reply: real personal/shared derived paths, durable proof, IMAP snapshot/UIDVALIDITY, source/capability fences and failure/forward/draft exclusions passed.');
  } finally { setImapClientFactoryForTests(null); loader._load = originalLoad; await postgres.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
