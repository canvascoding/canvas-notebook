export type AutomationJobStatus = 'active' | 'paused';
export type AutomationRunStatus = 'pending' | 'running' | 'success' | 'failed' | 'retry_scheduled';
export type AutomationTriggerType = 'scheduled' | 'manual' | 'retry' | 'webhook';
export type AutomationPreferredSkill = string;
export type AutomationJobType = 'default' | 'heartbeat' | 'webhook';
export type AutomationScope = 'personal' | 'organization';
export type AutomationWorkspaceType = 'personal' | 'team' | 'project';
export type AutomationActorType = 'user' | 'service';
export type AutomationDeliveryMode = 'web' | 'origin' | 'session' | 'channel_home' | 'last_active' | 'silent';
export type AutomationDeliverySessionMode = 'new_session' | 'channel_active' | 'fixed_session';
export type AutomationScheduleKind = 'once' | 'daily' | 'weekly' | 'interval' | 'webhook';
export type AutomationWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type AutomationIntervalUnit = 'minutes' | 'hours' | 'days';

export type AutomationWorkingHours = {
  enabled: boolean;
  days: AutomationWeekday[];
  start: string;
  end: string;
  timeZone: string;
};

type FriendlyScheduleOptions = {
  workingHours?: AutomationWorkingHours | null;
};

export type FriendlySchedule = (
  {
      kind: 'once';
      date: string;
      time: string;
      timeZone: string;
    }
  | {
      kind: 'daily';
      times: string[];
      timeZone: string;
    }
  | {
      kind: 'weekly';
      days: AutomationWeekday[];
      times: string[];
      timeZone: string;
    }
  | {
      kind: 'interval';
      every: number;
      unit: AutomationIntervalUnit;
      timeZone: string;
    }
  | {
      kind: 'webhook';
      timeZone: string;
    }
) & FriendlyScheduleOptions;

export type AutomationJobRecord = {
  id: string;
  name: string;
  status: AutomationJobStatus;
  scope: AutomationScope;
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: AutomationWorkspaceType;
  ownerUserId: string | null;
  responsibleUserId: string | null;
  serviceActorId: string | null;
  approvedByUserId: string | null;
  lastEditedByUserId: string | null;
  prompt: string;
  preferredSkill: AutomationPreferredSkill;
  workspaceContextPaths: string[];
  targetOutputPath: string | null;
  effectiveTargetOutputPath: string;
  schedule: FriendlySchedule;
  timeZone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  createdByUserId: string;
  agentId: string;
  deliveryMode: AutomationDeliveryMode;
  deliveryChannelId: string | null;
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId: string | null;
  deliveryChannelSessionKey: string | null;
  createdAt: string;
  updatedAt: string;
  jobType: AutomationJobType;
  channelId: string | null;
  composioTriggerId: string | null;
  composioTriggerSlug: string | null;
  composioToolkitSlug: string | null;
  composioConnectedAccountId: string | null;
  composioUserId: string | null;
  webhookTriggerConfig: Record<string, unknown> | null;
  customWebhookId?: string | null;
  customWebhookSecretPreview?: string | null;
  customWebhookStatus?: string | null;
  customWebhookCreatedAt?: string | null;
  customWebhookRotatedAt?: string | null;
};

export type AutomationRunRecord = {
  id: string;
  jobId: string;
  status: AutomationRunStatus;
  scope: AutomationScope;
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: AutomationWorkspaceType;
  actorType: AutomationActorType;
  actorUserId: string | null;
  serviceActorId: string | null;
  triggerType: AutomationTriggerType;
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attemptNumber: number;
  outputDir: string | null;
  targetOutputPath: string | null;
  effectiveTargetOutputPath: string | null;
  logPath: string | null;
  resultPath: string | null;
  errorMessage: string | null;
  piSessionId: string | null;
  piSessionTitle: string | null;
  hasPersistedSession: boolean;
  resultText: string | null;
  createdAt: string;
  // Metadata stored in DB instead of files
  eventsLog: string[] | null; // Parsed from JSON string
  metadataJson: Record<string, unknown> | null; // Parsed from JSON string
};

export type CreateAutomationJobInput = {
  name: string;
  prompt: string;
  scope?: AutomationScope | 'team';
  workspaceId?: string | null;
  responsibleUserId?: string | null;
  workspaceContextPaths?: string[];
  targetOutputPath?: string | null;
  preferredSkill?: AutomationPreferredSkill;
  agentId?: string;
  deliveryMode?: AutomationDeliveryMode;
  deliveryChannelId?: string | null;
  deliverySessionMode?: AutomationDeliverySessionMode;
  deliverySessionId?: string | null;
  deliveryChannelSessionKey?: string | null;
  schedule: FriendlySchedule;
  status?: AutomationJobStatus;
};

export type CreateWebhookAutomationJobInput = {
  name: string;
  prompt: string;
  scope?: AutomationScope | 'team';
  workspaceId?: string | null;
  responsibleUserId?: string | null;
  workspaceContextPaths?: string[];
  targetOutputPath?: string | null;
  preferredSkill?: AutomationPreferredSkill;
  agentId?: string;
  deliveryMode?: AutomationDeliveryMode;
  deliveryChannelId?: string | null;
  deliverySessionMode?: AutomationDeliverySessionMode;
  deliverySessionId?: string | null;
  deliveryChannelSessionKey?: string | null;
  status?: AutomationJobStatus;
  composioTriggerId: string;
  composioTriggerSlug: string;
  composioToolkitSlug: string;
  composioConnectedAccountId: string;
  composioUserId: string;
  webhookTriggerConfig?: Record<string, unknown>;
};

export type CreateCustomWebhookAutomationJobInput = {
  name: string;
  prompt: string;
  scope?: AutomationScope | 'team';
  workspaceId?: string | null;
  responsibleUserId?: string | null;
  workspaceContextPaths?: string[];
  targetOutputPath?: string | null;
  preferredSkill?: AutomationPreferredSkill;
  agentId?: string;
  deliveryMode?: AutomationDeliveryMode;
  deliveryChannelId?: string | null;
  deliverySessionMode?: AutomationDeliverySessionMode;
  deliverySessionId?: string | null;
  deliveryChannelSessionKey?: string | null;
  status?: AutomationJobStatus;
};

export type UpdateAutomationJobInput = Partial<Omit<CreateAutomationJobInput, 'scope' | 'workspaceId'>> & {
  lastRunStatus?: AutomationRunStatus | null;
};
