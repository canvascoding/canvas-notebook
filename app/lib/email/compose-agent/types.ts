export type EmailComposeAgentMode = 'compose' | 'forward' | 'reply' | 'reply-all';

export type EmailComposeTone = 'formal' | 'casual' | 'very-casual';

export type EmailComposeContextFile = {
  name?: string;
  path: string;
};

export type EmailComposeAgentInput = {
  accountId: string;
  cc?: unknown;
  contextFiles?: EmailComposeContextFile[];
  currentBody?: string;
  folder?: string;
  instruction: string;
  messageId?: string;
  mode?: EmailComposeAgentMode;
  subject?: string;
  to?: unknown;
  tone?: EmailComposeTone;
};

export type EmailComposeAgentUsedContext = {
  path: string;
  reason?: string;
};

export type EmailComposeAgentResult = {
  body: string;
  subjectSuggestion?: string;
  usedContext: EmailComposeAgentUsedContext[];
};

export type EmailComposeAgentStreamEvent =
  | { type: 'status'; label: string }
  | { type: 'tool_start'; id: string; toolName: string; args: unknown }
  | { type: 'tool_end'; id: string; toolName: string; resultPreview: string; contextPath?: string }
  | { type: 'final'; result: EmailComposeAgentResult }
  | { type: 'error'; message: string };

export type EmailComposeAgentEventSink = (event: EmailComposeAgentStreamEvent) => void | Promise<void>;
