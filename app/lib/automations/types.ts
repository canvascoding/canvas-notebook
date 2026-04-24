export type AutomationJobStatus = 'active' | 'paused';
export type AutomationRunStatus = 'pending' | 'running' | 'success' | 'failed' | 'retry_scheduled';
export type AutomationTriggerType = 'scheduled' | 'manual' | 'retry';
export type AutomationPreferredSkill = 'auto';
export type AutomationScheduleKind = 'once' | 'daily' | 'weekly' | 'interval';
export type AutomationWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type AutomationIntervalUnit = 'minutes' | 'hours' | 'days';

export type FriendlySchedule =
  | {
      kind: 'once';
      date: string;
      time: string;
      timeZone: string;
    }
  | {
      kind: 'daily';
      time: string;
      timeZone: string;
    }
  | {
      kind: 'weekly';
      days: AutomationWeekday[];
      time: string;
      timeZone: string;
    }
  | {
      kind: 'interval';
      every: number;
      unit: AutomationIntervalUnit;
      timeZone: string;
    };

export type AutomationJobRecord = {
  id: string;
  name: string;
  status: AutomationJobStatus;
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
  createdAt: string;
  updatedAt: string;
};

export type AutomationRunRecord = {
  id: string;
  jobId: string;
  status: AutomationRunStatus;
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
  createdAt: string;
  // Metadata stored in DB instead of files
  eventsLog: string[] | null; // Parsed from JSON string
  metadataJson: Record<string, unknown> | null; // Parsed from JSON string
};

export type CreateAutomationJobInput = {
  name: string;
  prompt: string;
  workspaceContextPaths?: string[];
  targetOutputPath?: string | null;
  schedule: FriendlySchedule;
  status?: AutomationJobStatus;
};

export type UpdateAutomationJobInput = Partial<CreateAutomationJobInput> & {
  lastRunStatus?: AutomationRunStatus | null;
};
