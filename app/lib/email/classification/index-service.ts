import 'server-only';

import { isEmailAddressAllowed } from '@/app/lib/email/policy';
import { emailClassificationFingerprint, emailClassificationMessageIdentity, emailClassificationReplyStatus } from './identity';
import type { AuthorizedEmailClassificationMailbox } from './mailbox-types';
import { projectEmailClassification } from './policy';
import { emailClassificationEvaluationFingerprint } from './settings-evaluation';
import type { EmailClassificationConfiguration, EmailClassificationSettings } from './settings-types';
import { getRuntimeEmailClassificationStore, type PostgresEmailClassificationStore } from './store';
import { EmailClassificationStoreStateError, type EmailIndexedMessageList, type StoredEmailClassificationMetadata, type StoredEmailClassificationResult } from './store-types';
import type { EmailClassification } from './types';

type IndexStore = Pick<PostgresEmailClassificationStore,
  'readSettings' | 'upsertMailbox' | 'readMailbox' | 'upsertMessageMetadata' | 'readMessages' | 'readResultsBatch'
  | 'readPersonalFocusStates' | 'readClassificationJobStates' | 'enqueueClassification'>;

export interface EmailClassificationIndexDependencies { store?: IndexStore }
export type EmailClassificationReplyProvenance = 'cache' | 'provider' | 'imap';

export interface EmailClassificationIndexProjection {
  classification: EmailClassification;
  metadata: StoredEmailClassificationMetadata | null;
  result: StoredEmailClassificationResult | null;
  personalFocusVersion: number;
}

async function indexStore(dependencies: EmailClassificationIndexDependencies): Promise<IndexStore> {
  return dependencies.store ?? getRuntimeEmailClassificationStore();
}

/** The caller supplies a freshly authorized source; registration never grants access. */
export async function registerEmailClassificationMailboxes(mailboxes: AuthorizedEmailClassificationMailbox[], dependencies: EmailClassificationIndexDependencies = {}): Promise<void> {
  const store = await indexStore(dependencies);
  for (const mailbox of mailboxes) await store.upsertMailbox(mailbox);
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function addresses(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((address): address is string => typeof address === 'string') : undefined;
}

/** Provider identities describe immutable mail contents; flags and variable-length previews are excluded. */
export function emailClassificationMetadataInput(mailbox: AuthorizedEmailClassificationMailbox, message: Record<string, unknown>, provenance: EmailClassificationReplyProvenance = 'provider') {
  const identity = emailClassificationMessageIdentity(mailbox, { ...message, id: text(message.id), folder: text(message.folder) || (mailbox.provider === 'microsoft' ? 'inbox' : 'INBOX') });
  const date = text(message.date);
  const parsedDate = Date.parse(date);
  const dateTimestamp = Number.isSafeInteger(parsedDate) && parsedDate >= 0 ? parsedDate : null;
  const list: EmailIndexedMessageList = { from: text(message.from), subject: text(message.subject), date, snippet: text(message.snippet) };
  const to = addresses(message.to); const cc = addresses(message.cc);
  if (to) list.to = to;
  if (cc) list.cc = cc;
  for (const key of ['isRead', 'isFlagged', 'hasAttachments'] as const) if (typeof message[key] === 'boolean') list[key] = message[key];
  if (typeof message.threadId === 'string' || message.threadId === null) list.threadId = message.threadId;
  return {
    messageRef: identity.messageRef, mailboxRef: mailbox.mailboxRef, canonicalId: identity.canonicalId, folder: identity.folder,
    dateTimestamp, replyStatus: emailClassificationReplyStatus(message, provenance),
    inInbox: typeof message.folder === 'string' && message.folder.toLowerCase() === 'inbox',
    fingerprint: emailClassificationFingerprint([mailbox.mailboxRef, identity.canonicalId, list.from, list.subject, dateTimestamp]),
    list,
  };
}

export function isStoredEmailClassificationResultCurrent(result: StoredEmailClassificationResult | null | undefined, metadata: StoredEmailClassificationMetadata, configuration: EmailClassificationConfiguration): boolean {
  return Boolean(result?.raw && metadata.mailbox.active && result.fingerprint === metadata.fingerprint
    && result.bindingRevision === metadata.mailbox.bindingRevision && result.policyRevision === metadata.mailbox.policyRevision
    && result.evaluationFingerprint === emailClassificationEvaluationFingerprint(configuration));
}

/** Metadata-only ingestion. This function never downloads bodies, runs a model or marks a mail read. */
export async function ingestEmailClassificationMetadata(input: {
  mailbox: AuthorizedEmailClassificationMailbox; message: Record<string, unknown>; enqueue: boolean;
  settings?: EmailClassificationSettings; provenance?: EmailClassificationReplyProvenance; inInbox?: boolean; inboxSeenAt?: number; now?: number;
}, dependencies: EmailClassificationIndexDependencies = {}): Promise<StoredEmailClassificationMetadata | null> {
  const { mailbox, message } = input;
  if (mailbox.workspaceId && !isEmailAddressAllowed(text(message.from), mailbox.readFrom)) return null;
  let metadataInput;
  try { metadataInput = emailClassificationMetadataInput(mailbox, message, input.provenance); }
  catch { return null; }
  const store = await indexStore(dependencies);
  const registered = await store.readMailbox(mailbox.mailboxRef);
  if (!registered?.active || registered.bindingRevision !== mailbox.bindingRevision || registered.policyRevision !== mailbox.policyRevision) return null;
  if (input.inInbox === true) metadataInput.inInbox = true;
  // Secondary provider views (labels, search, opaque Outlook folder IDs) do not
  // prove that an already indexed message has left the inbox. Mutations do.
  if (!metadataInput.inInbox) metadataInput.inInbox = (await store.readMessages([metadataInput.messageRef]))[0]?.inInbox ?? false;
  let metadata: StoredEmailClassificationMetadata;
  try {
    metadata = await store.upsertMessageMetadata({ ...metadataInput, lastSeenInboxAt: input.inboxSeenAt,
      expectedBindingRevision: mailbox.bindingRevision, expectedPolicyRevision: mailbox.policyRevision }, input.now);
  } catch (error) {
    if (error instanceof EmailClassificationStoreStateError) return null;
    throw error;
  }
  if (!input.enqueue || !metadata.inInbox || !isEmailAddressAllowed(metadata.list.from, mailbox.readFrom)) return metadata;
  const settings = input.settings ?? await store.readSettings();
  if (!settings.configuration.enabled) return metadata;
  const result = (await store.readResultsBatch([metadata.messageRef]))[0];
  if (!isStoredEmailClassificationResultCurrent(result, metadata, settings.configuration)) {
    await store.enqueueClassification({ messageRef: metadata.messageRef, configurationRevision: settings.revision, fingerprint: metadata.fingerprint, now: input.now });
  }
  return metadata;
}

/** One batch joins durable ratings after the short-lived provider cache has been read. */
export async function readEmailClassificationProjectionBatch(input: {
  actorUserId: string; mailbox: AuthorizedEmailClassificationMailbox; messages: Record<string, unknown>[];
  settings?: EmailClassificationSettings; provenance?: EmailClassificationReplyProvenance; now?: number;
}, dependencies: EmailClassificationIndexDependencies = {}): Promise<Map<string, EmailClassificationIndexProjection>> {
  if (input.messages.length > 1_000) throw new Error('Too many email classification messages.');
  const store = await indexStore(dependencies);
  const settings = input.settings ?? await store.readSettings();
  if (!settings.configuration.enabled) return new Map();
  const candidates = input.messages.flatMap(message => {
    if (input.mailbox.workspaceId && !isEmailAddressAllowed(text(message.from), input.mailbox.readFrom)) return [];
    try { return [{ message, metadata: emailClassificationMetadataInput(input.mailbox, message, input.provenance) }]; }
    catch { return []; }
  });
  const refs = [...new Set(candidates.map(candidate => candidate.metadata.messageRef))];
  if (!refs.length) return new Map();
  const [messages, results, focusStates, jobStates] = await Promise.all([
    store.readMessages(refs), store.readResultsBatch(refs), store.readPersonalFocusStates(input.actorUserId, refs),
    store.readClassificationJobStates(refs, settings.revision),
  ]);
  const messageMap = new Map(messages.map(message => [message.messageRef, message]));
  const resultMap = new Map(results.map(result => [result.messageRef, result]));
  const focusMap = new Map(focusStates.map(focus => [focus.messageRef, focus]));
  return new Map(candidates.map(candidate => {
    const metadata = messageMap.get(candidate.metadata.messageRef) ?? null;
    const result = resultMap.get(candidate.metadata.messageRef) ?? null;
    const focus = focusMap.get(candidate.metadata.messageRef);
    const current = metadata !== null && metadata.fingerprint === candidate.metadata.fingerprint
      && metadata.mailbox.bindingRevision === input.mailbox.bindingRevision && metadata.mailbox.policyRevision === input.mailbox.policyRevision
      && isStoredEmailClassificationResultCurrent(result, metadata, settings.configuration);
    const raw = current ? result!.raw : null;
    const state = current ? undefined : jobStates.get(candidate.metadata.messageRef) === 'failed' ? 'failed' : result?.raw ? 'stale' : 'pending';
    // True provider flags can update reply status before metadata sync catches up.
    const observedReply = emailClassificationReplyStatus(candidate.message, input.provenance);
    const replyStatus = observedReply !== 'unknown' ? observedReply : metadata?.replyStatus ?? 'unknown';
    return [candidate.metadata.messageRef, {
      classification: projectEmailClassification({ raw, overrides: result?.overrides, policy: settings.configuration.policy,
        replyStatus, personallyDone: focus?.done, version: result?.version, unavailableState: state }),
      metadata, result, personalFocusVersion: focus?.version ?? 0,
    }];
  }));
}
