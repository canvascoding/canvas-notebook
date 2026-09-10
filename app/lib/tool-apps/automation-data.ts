import type { AutomationJobRecord, FriendlySchedule } from '@/app/lib/automations/types';
import { validateFriendlySchedule } from '@/app/lib/automations/schedule';
import { isToolAppRecord } from './types';

export type AutomationAppData = {
  id: string;
  name: string;
  status: 'active' | 'paused';
  revision: number;
  schedule: FriendlySchedule;
  nextRunAt: string | null;
  updatedAt: string;
  triggerKind: string;
  integrityStatus: string;
  canChangeStatus: boolean;
};

/** Deliberate allowlist; never forward the job prompt, provider IDs or secrets. */
export function presentAutomationAppData(job: AutomationJobRecord, viewerUserId?: string): AutomationAppData {
  const responsible = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
  const canChangeStatus = Boolean(viewerUserId && (!job.composioTriggerId || responsible === viewerUserId)
    && !job.deletedAt && (job.status === 'active' || job.integrityStatus === 'valid'));
  const data = readAutomationAppData({ ...job, canChangeStatus });
  if (!data) throw new Error('Automation widget data is unavailable.');
  return data;
}

export function readAutomationAppData(value: unknown): AutomationAppData | null {
  if (!isToolAppRecord(value) || typeof value.id !== 'string' || value.id.length > 64
    || typeof value.name !== 'string' || value.name.length > 120
    || (value.status !== 'active' && value.status !== 'paused')
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.nextRunAt !== null && (typeof value.nextRunAt !== 'string' || !Number.isFinite(Date.parse(value.nextRunAt))))
    || typeof value.triggerKind !== 'string' || value.triggerKind.length > 32
    || typeof value.integrityStatus !== 'string' || value.integrityStatus.length > 32) return null;
  const { schedule } = validateFriendlySchedule(value.schedule);
  if (!schedule) return null;
  return { id: value.id, name: value.name, status: value.status, revision: Number(value.revision),
    schedule, nextRunAt: value.nextRunAt as string | null, updatedAt: value.updatedAt,
    triggerKind: value.triggerKind, integrityStatus: value.integrityStatus, canChangeStatus: value.canChangeStatus === true };
}
