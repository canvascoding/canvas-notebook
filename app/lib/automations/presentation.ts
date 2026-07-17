import 'server-only';

import type { AutomationJobRecord } from './types';

export type PresentedAutomationJob = AutomationJobRecord & {
  composioConnectionManagedByViewer: boolean;
};

export function presentAutomationJobForViewer(
  job: AutomationJobRecord,
  viewerUserId: string,
): PresentedAutomationJob {
  const responsibleUserId = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
  const composioConnectionManagedByViewer = responsibleUserId === viewerUserId;
  if (composioConnectionManagedByViewer) {
    return { ...job, composioConnectionManagedByViewer: true };
  }
  return {
    ...job,
    composioTriggerId: null,
    composioConnectedAccountId: null,
    composioProfileId: null,
    composioUserId: null,
    webhookTriggerConfig: null,
    composioConnectionManagedByViewer: false,
  };
}
