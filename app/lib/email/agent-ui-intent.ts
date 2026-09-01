export type EmailAgentUiScope = 'personal' | 'workspace';

export type EmailAgentUiView =
  | 'mailboxes'
  | 'message-list'
  | 'message'
  | 'thread'
  | 'cases'
  | 'case'
  | 'review-draft'
  | 'review-center';

/**
 * A stable, provider-independent target for presenting an email tool result.
 * This metadata is for the Notebook UI and is not included in the text shown
 * to the agent.
 */
export type EmailAgentUiIntent = {
  view: EmailAgentUiView;
  mailboxId?: string;
  accountId?: string;
  emailAddress?: string;
  scope?: EmailAgentUiScope;
  workspaceId?: string;
  folder?: string;
  messageId?: string;
  threadId?: string;
  draftId?: string;
  query?: string;
  subject?: string;
};
