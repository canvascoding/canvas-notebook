import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import type { AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';
import type { EmailClassificationEnrichmentContext, EmailClassificationEnrichmentDependencies } from '../app/lib/email/classification/enrichment';
import type { EmailClassificationSettings } from '../app/lib/email/classification/settings-types';
import type { StoredEmailClassificationMetadata } from '../app/lib/email/classification/store-types';

class AccessError extends Error { status = 403; }
const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = loader._load;
let wrappers = false;
let routes = false;
const enrichmentCalls: EmailClassificationEnrichmentContext[] = [];
const routeCalls: Array<{ owner: string; options: Record<string, unknown> }> = [];
const raw = { id: 'message-1', folder: 'INBOX', from: 'allowed@example.test', subject: 'Question', isAnswered: false };
const localAccount = { id: 'local', provider: 'google', isPrimary: true, status: 'active' };
const managedAccount = { id: 'managed', provider: 'microsoft', status: 'active' };
let routeError: Error | null = null;
const routeService = async (owner: string, ...args: unknown[]) => {
  const options = args.at(-1) as Record<string, unknown>;
  routeCalls.push({ owner, options });
  if (routeError) throw routeError;
  return { message: raw, messages: [raw] };
};
const after = (_task: () => Promise<void>) => {};
loader._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db' || request === '@/app/lib/email/account-store') return {};
  if (request === '@/app/lib/email/mailbox-access') return {
    EmailMailboxAccessError: AccessError,
    listEmailMailboxes: () => { throw new Error('Use injected authorization'); },
    resolveEmailMailboxAccess: async () => ({ accountId: 'local', accountOwnerId: 'owner', workspaceId: 'work',
      readOptions: { enforceReadPolicy: true, cacheMode: undefined } }),
  };
  if (routes) {
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: 'actor' } }) } } };
    if (request === '@/app/lib/utils/rate-limit') return { rateLimit: () => ({ ok: true }) };
    if (request === '@/app/lib/email/service') return { listEmailMessages: routeService, searchEmail: routeService, readEmailMessage: routeService };
    if (request === 'next/server') return { ...originalLoad(request, parent, isMain) as object, after };
  }
  if (wrappers) {
    if (request === '@/app/lib/email/classification/enrichment' || request.endsWith('/email/classification/enrichment.ts')) return {
      enrichEmailClassificationPayload: async (payload: unknown, context: EmailClassificationEnrichmentContext) => {
        enrichmentCalls.push(context); return { ...payload as object, enrichmentJoined: true };
      },
      isEmailClassificationAccessUnavailableError: (error: unknown) => error instanceof Error && error.name === 'EmailClassificationAccessUnavailableError',
    };
    if (request.endsWith('/email/local-service')) return {
      listLocalEmailAccounts: async () => [localAccount],
      resolveLocalEmailCacheAccount: async () => ({ account: localAccount, provider: 'google' }),
      listLocalEmailMessages: async () => ({ account: localAccount, folder: 'INBOX', messages: [raw], total: 1 }),
      searchLocalEmail: async () => ({ account: localAccount, folder: 'INBOX', messages: [raw], total: 1 }),
      readLocalEmailMessage: async () => ({ account: localAccount, message: raw }),
    };
    if (request.endsWith('/email/managed-client')) return {
      isManagedEmailAvailable: () => true,
      managedEmailRequest: async (url: string) => url.endsWith('/accounts') ? { accounts: [managedAccount] }
        : url.endsWith('/search') ? { account: managedAccount, messages: [raw], total: 1, searchSyntaxVersion: 1, hasMore: false }
        : { account: managedAccount, message: raw },
    };
    if (request.endsWith('/email/cache/read-through')) return {
      readThroughEmailList: async (input: { fromCache: (messages: unknown[], total: number) => object }) => ({ ...input.fromCache([raw], 1), cache: { source: 'cache' } }),
      readThroughEmailDetail: async (input: { fromCache: (message: unknown) => object }) => ({ ...input.fromCache(raw), cache: { source: 'cache' } }),
    };
    if (request.endsWith('/email/cache/store')) return { normalizeEmailCacheProvider: (provider: string) => provider, getRuntimeEmailCacheStore: async () => ({}) };
    if (['/email/cache/consistency', '/email/attachments', '/email/smtp-service'].some(suffix => request.endsWith(suffix))) return {};
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { enrichEmailClassificationPayload, EmailClassificationAccessUnavailableError } = await import('../app/lib/email/classification/enrichment');
  const { emailClassificationMailboxRef, emailClassificationMessageIdentity } = await import('../app/lib/email/classification/identity');
  const { projectEmailClassification } = await import('../app/lib/email/classification/policy');
  const { createImapMessageReference } = await import('../app/lib/email/imap-service');
  const mailboxInput = { ownerUserId: 'owner', accountSource: 'local' as const, accountId: 'local', workspaceId: null, mailboxId: null };
  const mailbox: AuthorizedEmailClassificationMailbox = { ...mailboxInput, mailboxRef: emailClassificationMailboxRef(mailboxInput), provider: 'google',
    bindingRevision: 'binding-1', policyRevision: 'policy-1', active: true, readFrom: ['allowed@example.test'],
    emailAddress: 'owner@example.test', displayName: 'Owner', workspaceName: null,
    capabilities: { canRead: true, canWrite: false, canDelete: false, canRunAgent: false, canManage: false } };
  const sharedInput = { ...mailboxInput, workspaceId: 'work', mailboxId: 'shared-binding' };
  const shared = { ...mailbox, ...sharedInput, mailboxRef: emailClassificationMailboxRef(sharedInput), workspaceName: 'Work' };
  const settings: EmailClassificationSettings = { revision: 1, configuration: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, enabled: true }, updatedAt: null, updatedByUserId: null };
  const context: EmailClassificationEnrichmentContext = { actorUserId: 'owner', accountOwnerId: 'owner', accountId: 'local', accountSource: 'local', folder: 'INBOX', provenance: 'cache' };
  const classification = projectEmailClassification({ raw: null, policy: settings.configuration.policy, replyStatus: 'unknown' });
  const metadata = { messageRef: emailClassificationMessageIdentity(mailbox, raw).messageRef } as StoredEmailClassificationMetadata;
  const scheduled: Array<() => Promise<void>> = [];
  const writes: Array<{ kind: string; input: unknown }> = [];
  const batches: Array<Parameters<NonNullable<EmailClassificationEnrichmentDependencies['readProjectionBatch']>>[0]> = [];
  const authorizationActors: string[] = [];
  let currentMailboxes = [mailbox, shared];
  let currentSettings = settings;
  let hasMetadata = true;
  let registryFailure = false;
  let projectionFailure = false;
  const dependencies: EmailClassificationEnrichmentDependencies = {
    resolveMailboxes: async actor => { authorizationActors.push(actor); if (registryFailure) throw new Error('Private DB detail'); return currentMailboxes; },
    readSettings: async () => currentSettings,
    readProjectionBatch: async input => {
      batches.push(input); if (projectionFailure) throw new Error('Private storage detail');
      return new Map(input.messages.map(value => [emailClassificationMessageIdentity(input.mailbox, value as typeof raw).messageRef,
        { classification, metadata: hasMetadata ? metadata : null }]));
    },
    registerMailboxes: async input => { writes.push({ kind: 'register', input }); },
    ingestMetadata: async input => { writes.push({ kind: 'ingest', input }); return metadata; },
  };
  const poisoned = { ...raw, classification: { raw: 'stale' }, messageRef: 'forged', origin: { capabilities: { canWrite: true } }, personalFocusVersion: 9, classificationRaw: { secret: true } };
  const input = { account: localAccount, messages: [poisoned, { ...poisoned, id: 'message-2' }], total: 2 };
  const result = await enrichEmailClassificationPayload(input, { ...context, scheduleBackgroundTask: task => scheduled.push(task) }, dependencies);
  assert.equal(batches.length, 1, 'A page uses one durable batch join');
  assert.equal(batches[0].messages.length, 2);
  assert.equal(batches[0].actorUserId, 'owner');
  assert.equal(result.messages?.[0].classification, classification);
  assert.equal(result.messages?.[0].origin?.capabilities.canWrite, false, 'Current read-only capability replaces stale cached origin');
  assert.equal(result.messages?.[0].replyStatus, 'unknown', 'Cached false is not unanswered evidence');
  assert.equal(result.messages?.[0].classificationRaw, undefined);
  assert.equal(result.messages?.[0].personalFocusVersion, undefined);
  assert.equal(poisoned.messageRef, 'forged', 'Provider/cache objects stay untouched');
  assert.equal(writes.length, 0); assert.equal(scheduled.length, 0, 'Existing warm-cache metadata does not write');

  hasMetadata = false;
  await enrichEmailClassificationPayload({ message: raw }, { ...context, scheduleBackgroundTask: task => scheduled.push(task) }, dependencies);
  assert.equal(writes.length, 0, 'Missing metadata never writes in the request path');
  assert.equal(scheduled.length, 1);
  await scheduled.pop()!();
  assert.deepEqual(writes.map(value => value.kind), ['register', 'ingest'], 'Fresh authorization is registered before metadata ingestion');
  const ingestion = writes[1].input as { message: Record<string, unknown>; enqueue: boolean; provenance: string; inInbox: boolean };
  assert.equal(ingestion.enqueue, true); assert.equal(ingestion.provenance, 'cache'); assert.equal(ingestion.inInbox, true);
  assert.equal(ingestion.message.replyStatus, 'unknown');
  writes.length = 0;

  await enrichEmailClassificationPayload({ message: raw }, { ...context, scheduleBackgroundTask: task => scheduled.push(task) }, dependencies);
  currentMailboxes = [];
  await scheduled.pop()!(); assert.equal(writes.length, 0, 'Revoked access prevents background registration and queue writes');
  currentMailboxes = [mailbox, shared];
  await enrichEmailClassificationPayload({ message: raw }, { ...context, scheduleBackgroundTask: task => scheduled.push(task) }, dependencies);
  currentSettings = { ...settings, configuration: { ...settings.configuration, enabled: false } };
  await scheduled.pop()!(); assert.equal(writes.length, 0, 'Turning off centrally fences scheduled work');
  const disabled = await enrichEmailClassificationPayload({ message: poisoned }, context, dependencies);
  assert.equal(disabled.message?.classification, undefined); assert.equal(disabled.message?.origin, undefined);
  currentSettings = settings;

  const sharedContext = { ...context, actorUserId: 'actor', workspaceId: 'work' };
  const filtered = await enrichEmailClassificationPayload({ messages: [poisoned, { ...poisoned, id: 'denied', from: 'denied@example.test' }], total: 100, hasMore: true, nextOffset: 2 }, sharedContext, dependencies);
  assert.equal(filtered.messages?.length, 1); assert.equal(filtered.total, null, 'Restricted provider total is not exposed');
  assert.equal(filtered.hasMore, true); assert.equal(filtered.nextOffset, 2, 'Transport continuation still reaches later permitted mail');
  assert.equal(filtered.messages?.[0].origin?.workspaceId, 'work');
  assert.equal(authorizationActors.at(-1), 'actor');
  assert.equal(batches.at(-1)?.actorUserId, 'actor', 'Personal completion is actor-specific, not owner-specific');
  await assert.rejects(() => enrichEmailClassificationPayload({ message: { ...raw, from: 'denied@example.test' } }, sharedContext, dependencies), AccessError);
  registryFailure = true;
  await assert.rejects(() => enrichEmailClassificationPayload({ message: poisoned }, sharedContext, dependencies), EmailClassificationAccessUnavailableError);
  await assert.rejects(() => enrichEmailClassificationPayload({ message: poisoned }, { ...context, actorUserId: 'actor' }, dependencies), EmailClassificationAccessUnavailableError);
  const legacy = await enrichEmailClassificationPayload({ message: poisoned }, context, dependencies);
  assert.equal(legacy.message?.classification, undefined, 'Authorized legacy personal browse can remain plain');
  registryFailure = false; currentMailboxes = [mailbox];
  await assert.rejects(() => enrichEmailClassificationPayload({ message: poisoned }, sharedContext, dependencies), AccessError);
  currentMailboxes = [mailbox, shared]; projectionFailure = true;
  const degraded = await enrichEmailClassificationPayload({ message: poisoned }, sharedContext, dependencies);
  assert.equal(degraded.message?.classification, undefined); assert.equal(degraded.message?.messageRef, undefined, 'Storage outage strips stale fields after current access succeeds');
  projectionFailure = false;

  hasMetadata = true;
  const google = await enrichEmailClassificationPayload({ message: raw }, { ...context, provenance: 'provider' }, dependencies);
  assert.equal(google.message?.replyStatus, 'unknown', 'OAuth mapper false is unknown');
  const imap = { ...mailbox, provider: 'imap' };
  currentMailboxes = [imap];
  const imapRaw = { ...raw, id: createImapMessageReference('INBOX', '10', 7) };
  const native = await enrichEmailClassificationPayload({ message: imapRaw }, { ...context, provenance: 'provider' }, dependencies);
  assert.equal(native.message?.replyStatus, 'unanswered', 'Live IMAP flags prove unanswered');
  const cached = await enrichEmailClassificationPayload({ message: imapRaw }, context, dependencies);
  assert.equal(cached.message?.replyStatus, 'unknown');
  const beforeSkip = batches.length;
  const skipped = await enrichEmailClassificationPayload({ message: poisoned }, { ...context, skipClassification: true }, dependencies);
  assert.equal(batches.length, beforeSkip); assert.equal(skipped.message?.classification, undefined);
}

async function verifyWrappers() {
  wrappers = true;
  const { listEmailMessages, readEmailMessage, searchEmail } = await import('../app/lib/email/service');
  const swr = { actorUserId: 'actor', workspaceId: 'work', enforceReadPolicy: false, cacheMode: 'swr' as const };
  const provider = { ...swr, cacheMode: 'provider' as const };
  const cases = [
    { name: 'local cache list', run: () => listEmailMessages('owner', { accountId: 'local', folder: 'INBOX' }, swr), source: 'local', provenance: 'cache' },
    { name: 'local query bypass', run: () => listEmailMessages('owner', { accountId: 'local', query: 'question' }, swr), source: 'local', provenance: 'provider' },
    { name: 'local all-folder bypass', run: () => listEmailMessages('owner', { accountId: 'local', folder: 'all' }, swr), source: 'local', provenance: 'provider' },
    { name: 'local provider list', run: () => listEmailMessages('owner', { accountId: 'local' }, provider), source: 'local', provenance: 'provider' },
    { name: 'local search', run: () => searchEmail('owner', { accountId: 'local' }, provider), source: 'local', provenance: 'provider' },
    { name: 'local cache detail', run: () => readEmailMessage('owner', 'local', 'message-1', 'INBOX', swr), source: 'local', provenance: 'cache' },
    { name: 'local provider detail', run: () => readEmailMessage('owner', 'local', 'message-1', 'INBOX', provider), source: 'local', provenance: 'provider' },
    { name: 'managed list', run: () => listEmailMessages('owner', { accountId: 'managed' }, provider), source: 'managed', provenance: 'provider' },
    { name: 'managed search', run: () => searchEmail('owner', { accountId: 'managed' }, provider), source: 'managed', provenance: 'provider' },
    { name: 'managed cache detail', run: () => readEmailMessage('owner', 'managed', 'message-1', 'INBOX', swr), source: 'managed', provenance: 'cache' },
    { name: 'managed provider detail', run: () => readEmailMessage('owner', 'managed', 'message-1', 'INBOX', provider), source: 'managed', provenance: 'provider' },
  ];
  for (const test of cases) {
    const previous = enrichmentCalls.length;
    const payload = await test.run() as { enrichmentJoined?: boolean };
    assert.equal(payload.enrichmentJoined, true, test.name); assert.equal(enrichmentCalls.length, previous + 1, test.name);
    assert.equal(enrichmentCalls.at(-1)?.accountSource, test.source, test.name);
    assert.equal(enrichmentCalls.at(-1)?.provenance, test.provenance, test.name);
    assert.equal(enrichmentCalls.at(-1)?.actorUserId, 'actor'); assert.equal(enrichmentCalls.at(-1)?.accountOwnerId, 'owner');
    assert.equal(enrichmentCalls.at(-1)?.workspaceId, 'work');
  }
  const beforeWorker = enrichmentCalls.length;
  await readEmailMessage('owner', 'local', 'message-1', 'INBOX', { ...provider, skipClassification: true });
  await listEmailMessages('owner', { accountId: 'local' }, { ...provider, skipClassification: true });
  await searchEmail('owner', { accountId: 'managed' }, { ...provider, skipClassification: true });
  assert.equal(enrichmentCalls.length, beforeWorker, 'Background worker raw reads never recurse through the registry/join');

  routes = true;
  const { NextRequest } = await import('next/server');
  const listRoute = await import('../app/api/email/messages/list/route');
  const searchRoute = await import('../app/api/email/search/route');
  const detailRoute = await import('../app/api/email/accounts/[accountId]/messages/[messageId]/route');
  const routeRequests = [
    () => listRoute.POST(new NextRequest('http://localhost/api/email/messages/list', { method: 'POST', body: JSON.stringify({ accountId: 'local', mailboxWorkspaceId: 'work' }) })),
    () => searchRoute.POST(new NextRequest('http://localhost/api/email/search', { method: 'POST', body: JSON.stringify({ accountId: 'local', mailboxWorkspaceId: 'work' }) })),
    () => detailRoute.GET(new NextRequest('http://localhost/api/email/accounts/local/messages/message-1?mailboxWorkspaceId=work'), { params: Promise.resolve({ accountId: 'local', messageId: 'message-1' }) }),
  ];
  for (const request of routeRequests) {
    const response = await request(); assert.equal(response.status, 200);
    assert.equal(routeCalls.at(-1)?.owner, 'owner'); assert.equal(routeCalls.at(-1)?.options.actorUserId, 'actor');
    assert.equal(routeCalls.at(-1)?.options.workspaceId, 'work'); assert.equal(routeCalls.at(-1)?.options.scheduleBackgroundTask, after);
  }
  routeError = Object.assign(new Error('Mailbox access cannot be confirmed. Please try again.'), { name: 'EmailClassificationAccessUnavailableError', code: 'EMAIL_CLASSIFICATION_ACCESS_UNAVAILABLE', status: 503 });
  for (const request of routeRequests) {
    const response = await request(); assert.equal(response.status, 503);
    const body = await response.json(); assert.equal(body.code, 'EMAIL_CLASSIFICATION_ACCESS_UNAVAILABLE'); assert.equal(body.data, undefined);
    assert.doesNotMatch(body.error, /Private/);
  }
  console.log('Email enrichment passed: one batch after cache, current origins and read-only policy, deferred metadata, revocation/disable fences, safe failure boundaries, answer provenance, all read wrapper paths, worker bypass and route actor/workspace propagation.');
}
async function run() {
  if (process.argv.includes('--wrappers')) return verifyWrappers();
  await main();
  // Fresh module state exercises public wrappers without replacing an already imported dynamic module.
  execFileSync(process.execPath, [...process.execArgv, process.argv[1], '--wrappers'], { stdio: 'inherit' });
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { loader._load = originalLoad; });
