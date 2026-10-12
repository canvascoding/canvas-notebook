import assert from 'node:assert/strict';
import Module from 'node:module';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { resetChangedEmailSpamValidation, validateEmailClassificationConfiguration } from '../app/lib/email/classification/settings-validation';
import { emailClassificationEvaluationFingerprint } from '../app/lib/email/classification/settings-evaluation';
import { emailOriginSelectionKey, matchesEmailMailboxScope, parseEmailMailboxScope } from '../app/lib/email/classification/mailbox-types';
import type { EmailMailboxRegistryDependencies } from '../app/lib/email/classification/mailbox-registry';

class AccessError extends Error {}
const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db' || request === '@/app/lib/email/account-store') return {};
  if (request === '@/app/lib/email/mailbox-access') return { EmailMailboxAccessError: AccessError, listEmailMailboxes: () => { throw new Error('Use injected catalog'); }, resolveEmailMailboxAccess: () => { throw new Error('Use injected authorization'); } };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { emailClassificationMailboxRef, emailClassificationMessageIdentity, emailClassificationMessageOrigin, emailClassificationReplyStatus } = await import('../app/lib/email/classification/identity');
  const { resolveAuthorizedEmailClassificationMailboxes, canReadIndexedEmail, canClassifyIndexedEmail } = await import('../app/lib/email/classification/mailbox-registry');
  const { createImapMessageReference } = await import('../app/lib/email/imap-service');
  const now = new Date(1);
  const localRows = [
    { id: 'local', userId: 'owner', provider: 'google', authType: 'oauth', providerAccountId: null as string | null, emailAddress: 'local@example.test', status: 'active', accountScope: 'personal', policyJson: '{"readFrom":["allowed@example.test"]}', createdAt: now, updatedAt: now },
    { id: 'shared', userId: 'different-owner', provider: 'smtp_imap', authType: 'smtp_imap', providerAccountId: null as string | null, emailAddress: 'shared@example.test', status: 'active', accountScope: 'workspace', policyJson: '{"readFrom":["allowed@example.test"]}', createdAt: now, updatedAt: now },
  ];
  const bindingRows = [{ id: 'binding', emailAccountId: 'shared', workspaceId: 'work', status: 'active', updatedAt: now }];
  const capabilities = { canRead: true, canWrite: false, canDelete: false, canRunAgent: false, canManage: false };
  const catalogRows = [
    { id: 'local', provider: 'google', accountScope: 'personal', workspaceId: null, mailboxId: null, workspaceName: null },
    { id: 'managed-opaque', provider: 'microsoft', accountScope: 'personal', workspaceId: null, mailboxId: null, workspaceName: null },
    { id: 'shared', provider: 'smtp_imap', accountScope: 'workspace', workspaceId: 'work', mailboxId: 'binding', workspaceName: 'Work' },
    { id: 'send-only', provider: 'smtp_imap', accountScope: 'personal', workspaceId: null, mailboxId: null, workspaceName: null, canRead: false },
  ].map(row => ({ ...row, capabilities: { ...capabilities, canRead: row.canRead !== false }, connectionState: row.canRead === false ? 'send_only' : 'ready', emailAddress: `${row.id}@example.test`, displayName: row.id, policy: { readFrom: ['allowed@example.test'], sendTo: [] }, updatedAt: now.toISOString() }));
  const requests: Array<{ userId: string; accountId?: unknown; mailboxWorkspaceId?: unknown; operation: string }> = [];
  let accessRemoved = false;
  let accessFailed = false;
  const dependencies: EmailMailboxRegistryDependencies = {
    catalog: async () => ({ accounts: catalogRows, setup: {} } as unknown as Awaited<ReturnType<EmailMailboxRegistryDependencies['catalog']>>),
    access: async request => {
      requests.push(request);
      if (accessFailed) throw new Error('Database unavailable');
      if (accessRemoved && request.accountId === 'shared') throw new AccessError('Removed');
      const owner = { accountId: String(request.accountId), accountOwnerId: request.accountId === 'shared' ? 'different-owner' : request.userId };
      if (request.mailboxWorkspaceId) return { ...owner, workspaceId: String(request.mailboxWorkspaceId), mailboxId: 'binding', readOptions: { enforceReadPolicy: true, cacheMode: undefined }, readPolicy: { enforceReadPolicy: true, cacheMode: undefined } };
      return { ...owner, workspaceId: null, mailboxId: null, readOptions: { enforceReadPolicy: false, cacheMode: 'swr' as const }, readPolicy: { enforceReadPolicy: false, cacheMode: 'swr' as const } };
    },
    localAccounts: async () => localRows,
    bindings: async () => bindingRows,
  };
  const mailboxes = await resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'all' }, dependencies);
  assert.equal(mailboxes.length, 3); assert.equal(requests.length, 3, 'Send-only source is never read');
  assert(requests.every(request => request.operation === 'read' && request.userId === 'owner'));
  assert.deepEqual(mailboxes.map(mailbox => mailbox.accountSource), ['local', 'managed', 'local']);
  assert.equal(mailboxes[2].ownerUserId, 'different-owner'); assert.equal(mailboxes[2].provider, 'imap');
  assert.equal(mailboxes[2].capabilities.canWrite, false);
  localRows[0].updatedAt = new Date(9_000);
  const credentialRefresh = (await resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'personal' }, dependencies))[0];
  assert.equal(credentialRefresh.bindingRevision, mailboxes[0].bindingRevision, 'Token refresh timestamp must not invalidate classifications or sync coverage');
  assert.equal((await resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'personal' }, dependencies)).length, 2);
  assert.equal((await resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'work' }, dependencies)).length, 1);
  const shared = mailboxes[2];
  assert.equal((await resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'mailbox', mailboxRef: shared.mailboxRef }, dependencies)).length, 1);
  assert.equal(canReadIndexedEmail(shared, 'Denied <denied@example.test>'), false);
  assert.equal(canReadIndexedEmail(shared, 'Allowed <allowed@example.test>'), true);
  assert.equal(canReadIndexedEmail(mailboxes[0], 'denied@example.test'), true, 'Personal human browse preserves its existing contract');
  assert.equal(canClassifyIndexedEmail(mailboxes[0], 'denied@example.test'), false, 'Background AI preserves personal sender restriction');
  localRows[1].policyJson = '{"readFrom":["changed@example.test"]}';
  const changedPolicy = (await resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'work' }, dependencies))[0];
  assert.equal(canReadIndexedEmail(changedPolicy, 'allowed@example.test'), false, 'The current persisted policy wins over a stale catalog');
  localRows[1].policyJson = '{"readFrom":["allowed@example.test"]}';
  accessRemoved = true;
  assert.equal((await resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'all' }, dependencies)).length, 2, 'Fresh revocation removes origin');
  accessFailed = true;
  await assert.rejects(() => resolveAuthorizedEmailClassificationMailboxes('owner', { kind: 'all' }, dependencies), /Database unavailable/, 'Operational failure is not a false empty mailbox');

  const first = emailClassificationMessageIdentity(shared, { id: createImapMessageReference('INBOX', '10', 7), folder: 'INBOX' });
  const reset = emailClassificationMessageIdentity(shared, { id: createImapMessageReference('INBOX', '11', 7), folder: 'INBOX' });
  assert.notEqual(first.messageRef, reset.messageRef, 'UIDVALIDITY reset makes a new identity');
  assert.throws(() => emailClassificationMessageIdentity(shared, { id: '7', folder: 'INBOX' }), /UIDVALIDITY/);
  assert.throws(() => emailClassificationMessageIdentity(shared, { id: first.canonicalId, folder: 'Wrong' }), /Inconsistent/);
  assert.notEqual(first.messageRef, emailClassificationMessageIdentity({ ...shared, mailboxRef: mailboxes[0].mailboxRef }, { id: first.canonicalId, folder: 'INBOX' }).messageRef, 'Same IMAP UID in different accounts is independent');
  assert.notEqual(shared.mailboxRef, emailClassificationMailboxRef({ ...shared, ownerUserId: 'another-owner' }));
  assert.notEqual(shared.mailboxRef, emailClassificationMailboxRef({ ...shared, accountSource: 'managed' }));
  const origin = emailClassificationMessageOrigin(shared, first);
  assert.equal(origin.accountOwnerId, 'different-owner'); assert.equal(origin.workspaceId, 'work');
  assert.equal(origin.canonicalId, first.canonicalId);
  assert.notEqual(emailOriginSelectionKey(origin), emailOriginSelectionKey({ ...origin, accountId: 'another' }));
  assert.equal(emailClassificationReplyStatus({ isAnswered: false }, 'cache'), 'unknown');
  assert.equal(emailClassificationReplyStatus({ isAnswered: false }, 'provider'), 'unknown', 'Google/Microsoft synthetic false is not evidence');
  assert.equal(emailClassificationReplyStatus({ isAnswered: false }, 'imap'), 'unanswered', 'Native IMAP flags are available');
  assert.equal(emailClassificationReplyStatus({ isAnswered: false, answerStatusAvailable: true }, 'cache'), 'unanswered');
  assert.equal(emailClassificationReplyStatus({ isAnswered: true }, 'cache'), 'answered');
  assert.equal(emailClassificationReplyStatus({}), 'unknown');
  assert.deepEqual(parseEmailMailboxScope('mailbox', shared.mailboxRef), { kind: 'mailbox', mailboxRef: shared.mailboxRef });
  assert.throws(() => parseEmailMailboxScope('mailbox', 'forged'));
  assert(matchesEmailMailboxScope(shared, { kind: 'work' }));

  assert.deepEqual(validateEmailClassificationConfiguration(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION);
  assert.throws(() => validateEmailClassificationConfiguration({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, apiKey: 'must-not-be-stored' }));
  assert.throws(() => validateEmailClassificationConfiguration({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, concurrency: 64 }));
  assert.throws(() => validateEmailClassificationConfiguration({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, credentialKey: 'user-key' }));
  const compatible = validateEmailClassificationConfiguration({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, providerId: 'systemone', endpoint: 'http://127.0.0.1:8000', model: 'kev', credentialKey: null, allowPrivateNetwork: true });
  assert.equal(compatible.endpoint, 'http://127.0.0.1:8000/v1/systemone');
  assert.throws(() => validateEmailClassificationConfiguration({ ...compatible, allowPrivateNetwork: false }));
  const validated = { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, policy: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION.policy, spamSortingValidated: true, calibrationReference: 'evaluation-v1', validatedProviderId: 'typesafe', validatedModel: 'jev-1.13.0', validatedSchemaVersion: 'email-triage.v1' } };
  assert.equal(resetChangedEmailSpamValidation(validated, { ...validated, enabled: true }).policy.spamSortingValidated, true, 'Toggle alone preserves validation');
  assert.equal(resetChangedEmailSpamValidation(validated, { ...validated, model: 'new-model' }).policy.spamSortingValidated, false);
  assert.equal(resetChangedEmailSpamValidation(validated, { ...validated, questionProfile: { ...validated.questionProfile, workPurpose: 'Changed purpose' } }).policy.spamSortingValidated, false);
  const evaluationFingerprint = emailClassificationEvaluationFingerprint(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION);
  assert.equal(emailClassificationEvaluationFingerprint({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, enabled: true, maxEmailsPerDay: 5 }), evaluationFingerprint, 'Toggle/budget do not invalidate raw answers');
  assert.equal(emailClassificationEvaluationFingerprint({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, policy: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION.policy, replyPositiveThreshold: 0.8 } }), evaluationFingerprint, 'Display policy can reuse raw answers');
  assert.notEqual(emailClassificationEvaluationFingerprint({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, model: 'different' }), evaluationFingerprint);
  console.log('Email classification identity/settings passed: authorized origins, sources, sender policy, revocation, IMAP lifetime, unknown answer provenance and validation reset.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { loader._load = originalLoad; });
