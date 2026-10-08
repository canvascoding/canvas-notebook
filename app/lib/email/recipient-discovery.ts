import 'server-only';

import { emailReplyRecipients, parseEmailAddresses, type EmailAddress } from './addresses';
import { isEmailAddressAllowed } from './policy';
import type { AuthorizedEmailClassificationMailbox, EmailMailboxScope } from './classification/mailbox-types';
import type { EmailReadPolicyOptions } from './service';
import type {
  EmailRecipientCandidate, EmailRecipientDiscoveryBaseInput, EmailRecipientDiscoveryResult,
  EmailRecipientReason, EmailRecipientSourceRole, EmailReplyRecipientSuggestions,
  FindEmailRecipientsInput, SuggestEmailReplyRecipientsInput,
} from './recipient-discovery-types';

const PAGE_SIZE = 25;
const MAX_CANDIDATES = 5;
const MAX_RESULT_CHARS = 7_500;
const MAX_MESSAGE_ID = 1_024;
const MAX_FOLDER = 240;

export class EmailRecipientDiscoveryError extends Error {
  constructor(public readonly code: 'INVALID_RECIPIENT_QUERY' | 'MAILBOX_ACCESS_UNAVAILABLE' | 'EMAIL_PROVIDER_UNAVAILABLE' | 'INVALID_EMAIL_SOURCE', message: string, public readonly status: 400 | 403 | 502 = 400) {
    super(message);
    this.name = 'EmailRecipientDiscoveryError';
  }
}

export interface EmailRecipientDiscoveryDependencies {
  resolveMailboxes(actorUserId: string, scope: EmailMailboxScope): Promise<AuthorizedEmailClassificationMailbox[]>;
  search(ownerUserId: string, input: { accountId: string; folder: string; query: string; offset: number; limit: number }, options: EmailReadPolicyOptions): Promise<unknown>;
  read(ownerUserId: string, accountId: string, messageId: string, folder: string | undefined, options: EmailReadPolicyOptions): Promise<unknown>;
}

const runtimeDependencies: EmailRecipientDiscoveryDependencies = {
  async resolveMailboxes(actorUserId, scope) {
    const { resolveAuthorizedEmailClassificationMailboxes } = await import('./classification/mailbox-registry');
    return resolveAuthorizedEmailClassificationMailboxes(actorUserId, scope);
  },
  async search(ownerUserId, input, options) {
    const { searchEmail } = await import('./service');
    return searchEmail(ownerUserId, input, options);
  },
  async read(ownerUserId, accountId, messageId, folder, options) {
    const { readEmailMessage } = await import('./service');
    return readEmailMessage(ownerUserId, accountId, messageId, folder, options);
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function identifier(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function invalid(message: string): never {
  throw new EmailRecipientDiscoveryError('INVALID_RECIPIENT_QUERY', message);
}

function normalizeBase(input: EmailRecipientDiscoveryBaseInput) {
  const actorUserId = identifier(input.actorUserId, 200);
  const accountId = identifier(input.accountId, 200);
  const workspaceId = input.mailboxWorkspaceId == null ? null : identifier(input.mailboxWorkspaceId, 200);
  if (!actorUserId || !accountId || input.mailboxWorkspaceId != null && !workspaceId) invalid('Select a valid mailbox.');
  if (input.purpose !== 'agent' && input.purpose !== 'human') invalid('Select a valid recipient discovery purpose.');
  if (input.exclude !== undefined && (!Array.isArray(input.exclude) || input.exclude.length > 50
    || input.exclude.some(value => !identifier(value, 400) || parseEmailAddresses(value).length !== 1))) {
    invalid('Exclude at most 50 valid recipient values.');
  }
  return { ...input, actorUserId, accountId, workspaceId, exclude: new Set(parseEmailAddresses(input.exclude || []).map(item => item.address)) };
}

type NormalizedBase = ReturnType<typeof normalizeBase>;
type AuthorizedSource = { mailbox: AuthorizedEmailClassificationMailbox; ownAddresses: Set<string> };

async function authorize(input: NormalizedBase, dependencies: EmailRecipientDiscoveryDependencies): Promise<AuthorizedSource> {
  let mailboxes: AuthorizedEmailClassificationMailbox[];
  try { mailboxes = await dependencies.resolveMailboxes(input.actorUserId, { kind: 'all' }); }
  catch { throw new EmailRecipientDiscoveryError('MAILBOX_ACCESS_UNAVAILABLE', 'Mailbox access cannot be confirmed. Please try again.', 403); }
  const mailbox = mailboxes.find(value => value.accountId === input.accountId && value.workspaceId === input.workspaceId);
  if (!mailbox?.active || !mailbox.capabilities.canRead || input.purpose === 'agent' && !mailbox.capabilities.canRunAgent) {
    throw new EmailRecipientDiscoveryError('MAILBOX_ACCESS_UNAVAILABLE', 'This mailbox is unavailable for recipient discovery.', 403);
  }
  const ownAddresses = new Set([mailbox, ...mailboxes.filter(value => value.ownerUserId === input.actorUserId)]
    .flatMap(value => parseEmailAddresses(value.emailAddress).map(address => address.address)));
  return { mailbox: structuredClone(mailbox), ownAddresses };
}

async function reauthorize(input: NormalizedBase, source: AuthorizedSource, dependencies: EmailRecipientDiscoveryDependencies): Promise<void> {
  const current = await authorize(input, dependencies);
  const before = source.mailbox;
  const after = current.mailbox;
  if (before.mailboxRef !== after.mailboxRef || before.ownerUserId !== after.ownerUserId || before.accountSource !== after.accountSource
    || before.connectionRevision !== after.connectionRevision || before.bindingRevision !== after.bindingRevision || before.policyRevision !== after.policyRevision
    || JSON.stringify([...before.readFrom].sort()) !== JSON.stringify([...after.readFrom].sort())) {
    throw new EmailRecipientDiscoveryError('MAILBOX_ACCESS_UNAVAILABLE', 'Mailbox access changed. Please try again.', 403);
  }
  for (const address of current.ownAddresses) source.ownAddresses.add(address);
}

function readOptions(input: NormalizedBase): EmailReadPolicyOptions {
  return { actorUserId: input.actorUserId, workspaceId: input.workspaceId, enforceReadPolicy: input.purpose === 'agent' || Boolean(input.workspaceId),
    cacheMode: 'provider', prefetchDetails: false, skipClassification: true };
}

function canUseMessage(input: NormalizedBase, mailbox: AuthorizedEmailClassificationMailbox, message: Record<string, unknown>): boolean {
  const sender = parseEmailAddresses(message.from)[0]?.address;
  if (!sender) return false;
  return input.purpose === 'human' && !input.workspaceId || isEmailAddressAllowed(sender, mailbox.readFrom);
}

function candidateFor(address: EmailAddress, message: Record<string, unknown>, role: EmailRecipientSourceRole, reason: EmailRecipientReason, fallbackFolder: string, fallbackId?: string): EmailRecipientCandidate | null {
  const messageId = identifier(message.id ?? fallbackId, MAX_MESSAGE_ID);
  const folder = identifier(message.folder ?? fallbackFolder, MAX_FOLDER);
  if (!messageId || !folder) return null;
  const parsedDate = typeof message.date === 'string' && message.date.length <= 120 ? Date.parse(message.date) : NaN;
  return { ...address, reason, source: { messageId, folder, role, ...(Number.isFinite(parsedDate) ? { date: new Date(parsedDate).toISOString() } : {}) } };
}

function isNoReply(address: string): boolean {
  return /^(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon)(?:[+._-].*)?@/iu.test(address);
}

function literalHeaderQuery(query: string): string {
  const literal = `"${query.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
  return `from:${literal} OR to:${literal} OR cc:${literal}`;
}

function searchIsIncomplete(payload: Record<string, unknown>, notice: string): boolean {
  return payload.hasMore !== false || !Number.isInteger(payload.total) || Number(payload.total) < 0 || Boolean(notice.trim());
}

function boundedHeader(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === 'string') {
    const addresses = parseEmailAddresses(value);
    return value.length <= 16_384 && addresses.length < 100 && addresses.every(address => (address.name?.length || 0) < 120);
  }
  if (Array.isArray(value)) return value.length < 100 && value.every(entry => boundedHeader(entry, depth + 1)) && parseEmailAddresses(value).length < 100;
  const item = record(value);
  if (typeof item?.name === 'string' && item.name.length > 120 || typeof item?.displayName === 'string' && item.displayName.length > 120) return false;
  if (item?.emailAddress) return boundedHeader(item.emailAddress, depth + 1);
  if (item?.value) return boundedHeader(item.value, depth + 1);
  return true;
}

function coverageNotice(rawNotice: string): string | undefined {
  if (!rawNotice) return undefined;
  if (/compatibility mode|not confirmed/iu.test(rawNotice)) return 'The managed mailbox cannot confirm complete search coverage.';
  if (/limit|checked (?:at most )?\d+/iu.test(rawNotice)) return 'The mailbox search reached its provider scan limit.';
  if (/word and phrase|partial words/iu.test(rawNotice)) return 'The provider may match names and partial words differently.';
  if (/read policy/iu.test(rawNotice)) return 'Results follow this mailbox\'s read policy.';
  return 'The mailbox reports search coverage limitations.';
}

function boundDiscoveryResult(result: EmailRecipientDiscoveryResult): EmailRecipientDiscoveryResult {
  while (JSON.stringify(result).length > MAX_RESULT_CHARS && result.candidates.length) { result.candidates.pop(); result.omittedCount++; }
  if (result.omittedCount) result.coverage.incomplete = true;
  if (result.coverage.incomplete && result.status === 'resolved') result.status = 'incomplete';
  return result;
}

function compareCandidates(left: EmailRecipientCandidate, right: EmailRecipientCandidate): number {
  const rank = (candidate: EmailRecipientCandidate) => candidate.reason === 'previous_recipient' ? 0 : candidate.reason === 'name_match' ? 1 : 2;
  return rank(left) - rank(right) || Number(Boolean(right.name)) - Number(Boolean(left.name))
    || (Date.parse(right.source.date || '') || 0) - (Date.parse(left.source.date || '') || 0)
    || left.address.localeCompare(right.address);
}

/** Finds observed header addresses in one explicit provider result page. It never creates or sends mail. */
export async function findEmailRecipients(input: FindEmailRecipientsInput, dependencies: EmailRecipientDiscoveryDependencies = runtimeDependencies): Promise<EmailRecipientDiscoveryResult> {
  const base = normalizeBase(input);
  const query = typeof input.query === 'string' && input.query.length <= 120 ? input.query.normalize('NFC').trim() : '';
  if (query.length < 2 || query.length > 120 || typeof input.query !== 'string' || /[\u0000-\u001f\u007f]/u.test(input.query)) invalid('Use a name or address containing 2 to 120 characters.');
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) invalid('Use a valid recipient search page.');
  const folder = input.folder === undefined ? 'all' : identifier(input.folder, MAX_FOLDER);
  if (!folder) invalid('Select a valid mailbox folder.');
  const source = await authorize(base, dependencies);
  let value: unknown;
  try { value = await dependencies.search(source.mailbox.ownerUserId, { accountId: base.accountId, folder, query: literalHeaderQuery(query), offset, limit: PAGE_SIZE }, { ...readOptions(base), recipientDiscovery: true }); }
  catch { throw new EmailRecipientDiscoveryError('EMAIL_PROVIDER_UNAVAILABLE', 'Recipient search is unavailable. Please try again or use a known address.', 502); }
  await reauthorize(base, source, dependencies);
  const payload = record(value);
  if (!payload || !Array.isArray(payload.messages)) throw new EmailRecipientDiscoveryError('INVALID_EMAIL_SOURCE', 'The mailbox returned an invalid recipient search response.', 502);
  const rawNotice = typeof payload.searchNotice === 'string' ? payload.searchNotice.slice(0, 1_000) : '';
  const notice = coverageNotice(rawNotice);
  let incomplete = offset > 0 || searchIsIncomplete(payload, rawNotice) || payload.messages.length > PAGE_SIZE;
  const matches = new Map<string, EmailRecipientCandidate>();
  const needle = query.toLocaleLowerCase();
  for (const raw of payload.messages.slice(0, PAGE_SIZE)) {
    const message = record(raw);
    if (!message) { incomplete = true; continue; }
    if (['from', 'to', 'cc'].some(field => !boundedHeader(message[field]))) incomplete = true;
    if (!canUseMessage(base, source.mailbox, message)) continue;
    const ownFrom = parseEmailAddresses(message.from).some(address => source.ownAddresses.has(address.address));
    for (const role of ['from', 'to', 'cc'] as const) for (const address of parseEmailAddresses(message[role])) {
      if (source.ownAddresses.has(address.address) || base.exclude.has(address.address) || isNoReply(address.address)) continue;
      const nameMatch = address.name?.normalize('NFC').toLocaleLowerCase().includes(needle) === true;
      const addressMatch = address.address.includes(needle);
      if (!nameMatch && !addressMatch) continue;
      const reason = ownFrom && role !== 'from' ? 'previous_recipient' : nameMatch ? 'name_match' : 'address_match';
      const candidate = candidateFor(address, message, role, reason, folder);
      if (!candidate) { incomplete = true; continue; }
      const previous = matches.get(address.address);
      if (!previous || compareCandidates(candidate, previous) < 0) matches.set(address.address, candidate);
    }
  }
  const candidateCount = matches.size;
  const status = candidateCount > 1 ? 'ambiguous' : incomplete ? 'incomplete' : candidateCount === 1 ? 'resolved' : 'not_found';
  const candidates = [...matches.values()].sort(compareCandidates).slice(0, MAX_CANDIDATES);
  const hasMore = payload.hasMore === true;
  const nextOffset = hasMore && Number.isInteger(payload.nextOffset) && Number(payload.nextOffset) > offset && Number(payload.nextOffset) <= 10_000 ? Number(payload.nextOffset) : null;
  return boundDiscoveryResult({ status, candidates, candidateCount, omittedCount: candidateCount - candidates.length,
    coverage: { hasMore, nextOffset, incomplete, ...(notice ? { notice } : {}) } });
}

/** Suggests recipients from this message only; it does not claim complete thread membership. */
export async function suggestEmailReplyRecipients(input: SuggestEmailReplyRecipientsInput, dependencies: EmailRecipientDiscoveryDependencies = runtimeDependencies): Promise<EmailReplyRecipientSuggestions> {
  const base = normalizeBase(input);
  const messageId = identifier(input.messageId, MAX_MESSAGE_ID);
  const folder = input.folder === undefined ? undefined : identifier(input.folder, MAX_FOLDER);
  const mode = input.mode ?? 'reply';
  if (!messageId || folder === null || mode !== 'reply' && mode !== 'reply-all') invalid('Select a valid message and reply mode.');
  const source = await authorize(base, dependencies);
  let value: unknown;
  try { value = await dependencies.read(source.mailbox.ownerUserId, base.accountId, messageId, folder, readOptions(base)); }
  catch { throw new EmailRecipientDiscoveryError('EMAIL_PROVIDER_UNAVAILABLE', 'Reply recipients are unavailable. Please try again.', 502); }
  await reauthorize(base, source, dependencies);
  const message = record(record(value)?.message);
  if (!message || message.id !== undefined && message.id !== messageId || !canUseMessage(base, source.mailbox, message)) {
    throw new EmailRecipientDiscoveryError('INVALID_EMAIL_SOURCE', 'This message is unavailable for recipient discovery.', 403);
  }
  if (['from', 'to', 'cc', 'replyTo'].some(field => !boundedHeader(message[field]))) {
    throw new EmailRecipientDiscoveryError('INVALID_EMAIL_SOURCE', 'This message has too many recipient headers for suggestions. Use the regular reply composer.', 502);
  }
  const fallbackFolder = folder || (source.mailbox.provider === 'microsoft' ? 'inbox' : 'INBOX');
  const byAddress = new Map<string, EmailRecipientCandidate>();
  for (const [field, role, reason] of [['replyTo', 'reply-to', 'reply_to'], ['from', 'from', 'sender'], ['to', 'to', 'original_to'], ['cc', 'cc', 'original_cc']] as const) {
    for (const address of parseEmailAddresses(message[field])) {
      const candidate = candidateFor(address, message, role, reason, fallbackFolder, messageId);
      if (!candidate) throw new EmailRecipientDiscoveryError('INVALID_EMAIL_SOURCE', 'The message identity is invalid. Reload the mailbox and try again.', 502);
      if (!byAddress.has(address.address)) byAddress.set(address.address, candidate);
    }
  }
  const defaults = emailReplyRecipients(message, mode, source.ownAddresses);
  const selected = new Set([...source.ownAddresses, ...base.exclude]);
  const take = (addresses: string[]) => addresses.flatMap(address => {
    const candidate = byAddress.get(address);
    if (!candidate || selected.has(address)) return [];
    selected.add(address);
    return [candidate];
  });
  const to = take(defaults.to);
  const cc = take(defaults.cc);
  const optional: EmailRecipientCandidate[] = [];
  for (const role of ['to', 'cc'] as const) for (const address of parseEmailAddresses(message[role])) {
    if (selected.has(address.address) || isNoReply(address.address)) continue;
    const candidate = candidateFor(address, message, role, role === 'to' ? 'original_to' : 'original_cc', fallbackFolder, messageId);
    if (candidate) { selected.add(address.address); optional.push(candidate); }
  }
  const total = to.length + cc.length + optional.length;
  const result: EmailReplyRecipientSuggestions = { basis: 'current_message', replyRecipients: { to: to.slice(0, MAX_CANDIDATES), cc: cc.slice(0, Math.max(0, MAX_CANDIDATES - to.length)) },
    optionalAdditionalRecipients: optional.slice(0, Math.max(0, MAX_CANDIDATES - to.length - cc.length)), omittedCount: 0 };
  const returned = () => result.replyRecipients.to.length + result.replyRecipients.cc.length + result.optionalAdditionalRecipients.length;
  result.omittedCount = total - returned();
  while (JSON.stringify(result).length > MAX_RESULT_CHARS && returned()) {
    if (result.optionalAdditionalRecipients.length) result.optionalAdditionalRecipients.pop();
    else if (result.replyRecipients.cc.length) result.replyRecipients.cc.pop();
    else result.replyRecipients.to.pop();
    result.omittedCount++;
  }
  return result;
}
