import 'server-only';

import type { WorkspaceEmailAutomationEventContext } from '@/app/lib/email/workspace-email-automation-events';
import {
  createWorkspaceEmailTools,
  type WorkspaceEmailToolBindings,
  type WorkspaceEmailToolsContext,
} from '@/app/lib/pi/workspace-email-tools';

export type WorkspaceEmailAutomationToolContext = Pick<WorkspaceEmailAutomationEventContext,
  'mailboxId' | 'providerMessageId' | 'providerThreadId' | 'folder'
> & {
  eventId: string;
  userId: string;
  workspaceId: string;
  automationJobId: string;
  automationRunId: string;
  agentId: string;
};

/** The event runner binds the triggering mailbox, but uses the standard workspace tools. */
export function createWorkspaceEmailAutomationTools(context: WorkspaceEmailAutomationToolContext) {
  const bindings: WorkspaceEmailToolBindings = {
    mailboxId: context.mailboxId,
    providerMessageId: context.providerMessageId,
    providerThreadId: context.providerThreadId,
    folder: context.folder,
    eventId: context.eventId,
    automationJobId: context.automationJobId,
    automationRunId: context.automationRunId,
    agentId: context.agentId,
  };
  const sharedContext: WorkspaceEmailToolsContext = {
    userId: context.userId,
    workspaceId: context.workspaceId,
    bindings,
  };
  return createWorkspaceEmailTools(sharedContext);
}
