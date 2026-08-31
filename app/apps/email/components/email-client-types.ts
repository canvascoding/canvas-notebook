import type { EmailAttachmentDraft } from '@/app/lib/email/attachment-types';

export type WorkspaceInboxCase = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  requesterAddress?: string | null;
  requesterName?: string | null;
  assigneeUserId?: string | null;
  updatedAt: string;
};

export type EmailOutboxDraft = {
  id: string;
  subject: string;
  status: string | null;
  version: number;
  updatedAt: string;
  body: string;
  to: string[];
  cc: string[];
  bcc: string[];
  isHtml: boolean;
  attachments?: EmailAttachmentDraft[];
  inboxCaseId?: string | null;
  assignedUserId?: string | null;
  reviewCase?: WorkspaceInboxCase | null;
  originAutomationJobId?: string | null;
  originRunId?: string | null;
  originAgentId?: string | null;
};
