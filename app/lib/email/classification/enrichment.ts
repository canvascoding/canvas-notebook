import 'server-only';

import { EmailMailboxAccessError } from '@/app/lib/email/mailbox-access';
import type { EmailCacheBackgroundScheduler } from '@/app/lib/email/cache/read-through';
import { emailClassificationMessageIdentity, emailClassificationMessageOrigin, emailClassificationReplyStatus } from './identity';
import type { AuthorizedEmailClassificationMailbox, EmailMessageOrigin } from './mailbox-types';
import type { EmailClassificationSettings } from './settings-types';
import type { StoredEmailClassificationMetadata } from './store-types';
import type { EmailClassification } from './types';

type Message = Record<string, unknown>;

export interface EmailMessageClassificationFields {
  classification?: EmailClassification;
  messageRef?: string;
  origin?: EmailMessageOrigin;
}

export type EmailClassificationEnrichedPayload<T> = T & {
  messages?: Array<Message & EmailMessageClassificationFields>;
  message?: Message & EmailMessageClassificationFields;
};

export interface EmailClassificationEnrichmentContext {
  actorUserId: string;
  accountOwnerId: string;
  accountId: string;
  accountSource: 'local' | 'managed';
  workspaceId?: string | null;
  folder?: string;
  provenance?: 'provider' | 'cache' | 'imap';
  scheduleBackgroundTask?: EmailCacheBackgroundScheduler;
  skipClassification?: boolean;
}

type Projection = { classification: EmailClassification; metadata?: StoredEmailClassificationMetadata | null };

export interface EmailClassificationEnrichmentDependencies {
  resolveMailboxes?(actorUserId: string): Promise<AuthorizedEmailClassificationMailbox[]>;
  readSettings?(): Promise<EmailClassificationSettings>;
  registerMailboxes?(mailboxes: AuthorizedEmailClassificationMailbox[]): Promise<void>;
  readProjectionBatch?(input: {
    actorUserId: string; mailbox: AuthorizedEmailClassificationMailbox; messages: Message[];
    settings: EmailClassificationSettings; provenance: 'provider' | 'cache' | 'imap';
  }): Promise<Map<string, Projection>>;
  ingestMetadata?(input: {
    mailbox: AuthorizedEmailClassificationMailbox; message: Message; enqueue: boolean;
    settings?: EmailClassificationSettings; provenance?: 'provider' | 'cache' | 'imap'; inInbox?: boolean;
  }): Promise<StoredEmailClassificationMetadata | null>;
}

export class EmailClassificationAccessUnavailableError extends Error {
  readonly code = 'EMAIL_CLASSIFICATION_ACCESS_UNAVAILABLE';
  readonly status = 503;
  constructor() { super('Mailbox access cannot be confirmed. Please try again.'); this.name = 'EmailClassificationAccessUnavailableError'; }
}

export function isEmailClassificationAccessUnavailableError(error: unknown): error is EmailClassificationAccessUnavailableError {
  return error instanceof EmailClassificationAccessUnavailableError;
}

function message(value: unknown): Message | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Message : null;
}

/** Never trust previously cached or provider-supplied classification projections. */
export function stripEmailClassificationFields(value: Message): Message {
  const result = { ...value };
  for (const key of ['classification', 'messageRef', 'origin', 'personalFocusVersion', 'classificationRaw', 'classificationDetail']) delete result[key];
  return result;
}

function cleanPayload<T>(value: T): EmailClassificationEnrichedPayload<T> {
  const payload = message(value);
  if (!payload) return value as EmailClassificationEnrichedPayload<T>;
  return {
    ...payload,
    ...(Array.isArray(payload.messages) ? { messages: payload.messages.map(value => message(value) ? stripEmailClassificationFields(value as Message) : value) } : {}),
    ...(message(payload.message) ? { message: stripEmailClassificationFields(payload.message as Message) } : {}),
  } as EmailClassificationEnrichedPayload<T>;
}

async function resolveMailboxes(actorUserId: string, dependencies: EmailClassificationEnrichmentDependencies) {
  if (dependencies.resolveMailboxes) return dependencies.resolveMailboxes(actorUserId);
  const { resolveAuthorizedEmailClassificationMailboxes } = await import('./mailbox-registry');
  return resolveAuthorizedEmailClassificationMailboxes(actorUserId);
}

function matchingMailbox(mailboxes: AuthorizedEmailClassificationMailbox[], context: EmailClassificationEnrichmentContext) {
  return mailboxes.find(mailbox => mailbox.active && mailbox.capabilities.canRead
    && mailbox.ownerUserId === context.accountOwnerId && mailbox.accountId === context.accountId
    && mailbox.accountSource === context.accountSource && mailbox.workspaceId === (context.workspaceId || null));
}

async function readSettings(dependencies: EmailClassificationEnrichmentDependencies) {
  if (dependencies.readSettings) return dependencies.readSettings();
  const { getRuntimeEmailClassificationStore } = await import('./store');
  return (await getRuntimeEmailClassificationStore()).readSettings();
}

async function readProjectionBatch(input: Parameters<NonNullable<EmailClassificationEnrichmentDependencies['readProjectionBatch']>>[0], dependencies: EmailClassificationEnrichmentDependencies) {
  if (dependencies.readProjectionBatch) return dependencies.readProjectionBatch(input);
  const { readEmailClassificationProjectionBatch } = await import('./index-service');
  return readEmailClassificationProjectionBatch(input);
}

function normalizedMessage(value: Message, mailbox: AuthorizedEmailClassificationMailbox, context: EmailClassificationEnrichmentContext): Message {
  const result = { ...value };
  if (!result.folder && context.folder && context.folder !== 'all') result.folder = context.folder;
  // Cache mappers historically synthesize false; only a live IMAP flag proves unanswered.
  result.replyStatus = context.provenance === 'cache'
    ? value.isAnswered === true ? 'answered' : 'unknown'
    : emailClassificationReplyStatus(value, mailbox.provider === 'imap' || mailbox.provider === 'smtp_imap' ? 'imap' : 'provider');
  return result;
}

function identity(mailbox: AuthorizedEmailClassificationMailbox, value: Message, context: EmailClassificationEnrichmentContext) {
  if (typeof value.id !== 'string' || !value.id.trim() || context.folder === 'all' && !value.folder) return null;
  try {
    return emailClassificationMessageIdentity(mailbox, {
      id: value.id,
      ...(typeof value.folder === 'string' ? { folder: value.folder } : {}),
      ...(typeof value.uid === 'string' || typeof value.uid === 'number' ? { uid: value.uid } : {}),
      ...(typeof value.uidValidity === 'string' || typeof value.uidValidity === 'number' ? { uidValidity: value.uidValidity } : {}),
    });
  } catch { return null; }
}

/** Durable read joins happen once per response; registration and queue writes run after it. */
export async function enrichEmailClassificationPayload<T>(value: T, context: EmailClassificationEnrichmentContext, dependencies: EmailClassificationEnrichmentDependencies = {}): Promise<EmailClassificationEnrichedPayload<T>> {
  const clean = cleanPayload(value);
  if (context.skipClassification) return clean;
  const payload = message(clean);
  if (!payload || !context.accountId || !context.actorUserId) return clean;
  const requiresCurrentAuthorization = Boolean(context.workspaceId) || context.actorUserId !== context.accountOwnerId;
  let mailbox: AuthorizedEmailClassificationMailbox | undefined;
  try { mailbox = matchingMailbox(await resolveMailboxes(context.actorUserId, dependencies), context); }
  catch {
    if (requiresCurrentAuthorization) throw new EmailClassificationAccessUnavailableError();
    return clean;
  }
  if (!mailbox) {
    if (requiresCurrentAuthorization) throw new EmailMailboxAccessError('Workspace mailbox access was removed.');
    return clean;
  }
  const { canReadIndexedEmail } = await import('./mailbox-registry');
  const readable = (value: Message) => canReadIndexedEmail(mailbox!, typeof value.from === 'string' ? value.from : '');
  const sourceMessages = Array.isArray(payload.messages) ? payload.messages : message(payload.message) ? [payload.message] : [];
  const messages = sourceMessages.flatMap(value => message(value) && readable(value as Message) ? [normalizedMessage(value as Message, mailbox!, context)] : []);
  if (message(payload.message) && messages.length === 0) throw new EmailMailboxAccessError('This email is excluded by the mailbox read policy.');
  const filtered = Array.isArray(payload.messages) && messages.length !== sourceMessages.length;
  const normalizedPayload = {
    ...payload,
    ...(Array.isArray(payload.messages) ? { messages, ...(filtered ? { total: null } : {}) } : {}),
    ...(message(payload.message) ? { message: messages[0] } : {}),
  } as EmailClassificationEnrichedPayload<T>;
  let settings: EmailClassificationSettings;
  let projections: Map<string, Projection>;
  try {
    settings = await readSettings(dependencies);
    if (!settings.configuration.enabled || !messages.length) return normalizedPayload;
    projections = await readProjectionBatch({ actorUserId: context.actorUserId, mailbox, messages, settings, provenance: context.provenance ?? 'provider' }, dependencies);
  } catch { return normalizedPayload; }
  const missing: Message[] = [];
  const decorated = messages.map(value => {
    const ref = identity(mailbox!, value, context);
    if (!ref) return value;
    const projection = projections.get(ref.messageRef);
    if (!projection?.metadata || context.provenance !== 'cache') missing.push(value);
    return { ...value, messageRef: ref.messageRef, origin: emailClassificationMessageOrigin(mailbox!, ref), ...(projection ? { classification: projection.classification } : {}) };
  });
  if (context.scheduleBackgroundTask && missing.length) {
    try {
      context.scheduleBackgroundTask(async () => {
        try {
          const current = matchingMailbox(await resolveMailboxes(context.actorUserId, dependencies), context);
          if (!current || current.bindingRevision !== mailbox!.bindingRevision) return;
          const latest = await readSettings(dependencies);
          if (!latest.configuration.enabled) return;
          const register = dependencies.registerMailboxes ?? (await import('./index-service')).registerEmailClassificationMailboxes;
          await register([current]);
          const ingest = dependencies.ingestMetadata ?? (await import('./index-service')).ingestEmailClassificationMetadata;
          for (const value of missing) {
            if (!canReadIndexedEmail(current, typeof value.from === 'string' ? value.from : '')) continue;
            await ingest({ mailbox: current, message: value, enqueue: true, settings: latest,
              provenance: context.provenance ?? 'provider', inInbox: typeof value.folder === 'string' && value.folder.toLowerCase() === 'inbox' });
          }
        } catch { /* Optional background preparation never exposes provider or storage errors. */ }
      });
    } catch { /* A host without a post-response scheduler still returns durable assessments. */ }
  }
  return {
    ...normalizedPayload,
    ...(Array.isArray(payload.messages) ? { messages: decorated } : {}),
    ...(message(payload.message) ? { message: decorated[0] } : {}),
  } as EmailClassificationEnrichedPayload<T>;
}
