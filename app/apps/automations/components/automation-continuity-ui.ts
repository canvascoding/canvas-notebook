import type { AutomationJobRecord } from '@/app/lib/automations/types';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';

type SourceCandidate = Pick<AutomationJobRecord,
  'id' | 'name' | 'status' | 'integrityStatus' | 'scope' | 'organizationId'
  | 'workspaceId' | 'workspaceType' | 'ownerUserId' | 'createdByUserId'>;

export function selectEligibleAutomationSources<T extends SourceCandidate>(
  jobs: T[],
  workspace: ClientWorkspaceSummary | null | undefined,
  targetJobId: string | null,
): T[] {
  if (!workspace) return [];
  return jobs.filter((job) =>
    job.id !== targetJobId && job.status === 'active' && job.integrityStatus === 'valid'
    && job.workspaceId === workspace.id && job.workspaceType === workspace.type
    && job.scope === (workspace.type === 'personal' ? 'personal' : 'organization')
    && job.organizationId === (workspace.organizationId || null)
    && (workspace.type !== 'personal' || !workspace.ownerUserId
      || (job.ownerUserId || job.createdByUserId) === workspace.ownerUserId),
  );
}

export function toggleAutomationSourceSelection(current: string[], sourceJobId: string): string[] {
  if (current.includes(sourceJobId)) return current.filter((id) => id !== sourceJobId);
  if (current.length >= 3) return current;
  return [...current, sourceJobId];
}
