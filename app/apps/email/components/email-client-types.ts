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

export type EmailFolder = {
  id: string;
  name: string;
  path: string;
  role: string;
  selectable?: boolean;
  messageCount: number | null;
  unseenCount: number | null;
};

export type EmailMessageSummary = {
  id: string;
  uid?: string;
  folder?: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  isRead?: boolean;
  isAnswered?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
};

export type EmailMessageDetail = EmailMessageSummary & {
  to?: string[] | string;
  cc?: string[] | string;
  body?: string;
  bodyHtml?: string;
  attachments?: Array<{
    filename: string;
    contentType?: string;
    size?: number;
  }>;
};

export type EmailMessageViewerLabels = {
  aiReply: string;
  aiSummary: string;
  archive: string;
  backToMessages: string;
  attachments: string;
  cancel: string;
  cc: string;
  date: string;
  emptyBody: string;
  forward: string;
  from: string;
  loadingMessage: string;
  loadUpdatedMessage: string;
  markRead: string;
  markUnread: string;
  keepCurrentMessage: string;
  messageContentUpdated: string;
  messageOptions: string;
  messageUnavailable: string;
  moveTo: string;
  noFolders: string;
  noSubject: string;
  permanentDelete: string;
  remoteImagesBlocked: string;
  reply: string;
  replyAll: string;
  replyOptions: string;
  retryMessage: string;
  selectMessage: string;
  showRemoteImages: string;
  summary: string;
  summaryReady: string;
  summaryReadingContext: string;
  summaryWriting: string;
  to: string;
  trash: string;
  unknownAttachmentType: string;
};

export type EmailMessageActionName =
  | 'archive'
  | 'ai-reply'
  | 'clear-answered'
  | 'draft-forward'
  | 'draft-reply'
  | 'draft-reply-all'
  | 'mark-answered'
  | 'mark-read'
  | 'mark-unread'
  | 'move'
  | 'permanent-delete'
  | 'summary'
  | 'trash';

export type EmailMessageListActionName = 'archive' | 'mark-read' | 'mark-unread' | 'move' | 'permanent-delete' | 'trash';

export type EmailMessageListActionState = {
  action: EmailMessageListActionName;
  messageId: string;
} | null;

export type EmailMessageContextMenuPosition = {
  x: number;
  y: number;
};

export type EmailMessageViewerActions = {
  activeAction: EmailMessageActionName | null;
  folders: EmailFolder[];
  onAction(action: EmailMessageActionName, destination?: string): void;
};
