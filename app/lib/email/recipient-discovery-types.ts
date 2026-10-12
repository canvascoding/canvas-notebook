export type EmailRecipientDiscoveryPurpose = 'agent' | 'human';

export type EmailRecipientSourceRole = 'from' | 'to' | 'cc' | 'reply-to';
export type EmailRecipientReason = 'name_match' | 'address_match' | 'previous_recipient' | 'reply_to' | 'sender' | 'original_to' | 'original_cc';

export type EmailRecipientCandidate = {
  address: string;
  name?: string;
  reason: EmailRecipientReason;
  source: { messageId: string; folder: string; role: EmailRecipientSourceRole; date?: string };
};

export type EmailRecipientDiscoveryBaseInput = {
  actorUserId: string;
  accountId: string;
  mailboxWorkspaceId?: string | null;
  purpose: EmailRecipientDiscoveryPurpose;
  exclude?: string[];
};

export type FindEmailRecipientsInput = EmailRecipientDiscoveryBaseInput & {
  query: string;
  offset?: number;
  folder?: string;
};

export type SuggestEmailReplyRecipientsInput = EmailRecipientDiscoveryBaseInput & {
  messageId: string;
  folder?: string;
  mode?: 'reply' | 'reply-all';
};

export type EmailRecipientDiscoveryResult = {
  status: 'resolved' | 'ambiguous' | 'not_found' | 'incomplete';
  candidates: EmailRecipientCandidate[];
  candidateCount: number;
  omittedCount: number;
  coverage: { hasMore: boolean; nextOffset: number | null; incomplete: boolean; notice?: string };
};

export type EmailReplyRecipientSuggestions = {
  basis: 'current_message';
  replyRecipients: { to: EmailRecipientCandidate[]; cc: EmailRecipientCandidate[] };
  optionalAdditionalRecipients: EmailRecipientCandidate[];
  omittedCount: number;
};
