export type AutomationIntegrityIssueCode =
  | 'INVALID_SCOPE'
  | 'MISSING_OWNER'
  | 'RESPONSIBLE_OWNER_MISMATCH'
  | 'UNEXPECTED_PERSONAL_SERVICE_ACTOR'
  | 'UNEXPECTED_PERSONAL_APPROVAL'
  | 'UNEXPECTED_ORGANIZATION_OWNER'
  | 'MISSING_RESPONSIBLE_USER'
  | 'MISSING_SERVICE_ACTOR'
  | 'MISSING_ORGANIZATION_APPROVAL'
  | 'MISSING_ORGANIZATION'
  | 'MISSING_WORKSPACE'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_TYPE_MISMATCH'
  | 'WORKSPACE_ORGANIZATION_MISMATCH';

export type AutomationIntegrityIssue = {
  jobId: string;
  code: AutomationIntegrityIssueCode;
  message: string;
};

export type AutomationIntegrityRow = {
  id: string;
  scope: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: string | null;
  ownerUserId: string | null;
  responsibleUserId: string | null;
  serviceActorId: string | null;
  approvedByUserId: string | null;
  workspaceFound: string | null;
  actualWorkspaceType: string | null;
  actualWorkspaceOrganizationId: string | null;
};

export type AutomationIntegrityReport = {
  checkedAt: string;
  totalJobs: number;
  affectedJobIds: string[];
  issues: AutomationIntegrityIssue[];
};

function hasValue(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function pushIssue(
  issues: AutomationIntegrityIssue[],
  jobId: string,
  code: AutomationIntegrityIssueCode,
  message: string,
) {
  issues.push({ jobId, code, message });
}

/** Classifies inconsistent legacy job scope data without mutating it. */
export function inspectAutomationIntegrity(rows: AutomationIntegrityRow[]): AutomationIntegrityReport {
  const issues: AutomationIntegrityIssue[] = [];

  for (const job of rows) {
    const scope = job.scope === 'organization' ? 'organization' : job.scope === 'personal' ? 'personal' : null;
    if (!scope) {
      pushIssue(issues, job.id, 'INVALID_SCOPE', 'Automation scope must be personal or organization.');
      continue;
    }

    if (!hasValue(job.organizationId)) {
      pushIssue(issues, job.id, 'MISSING_ORGANIZATION', 'Automation job has no organization.');
    }
    if (!hasValue(job.workspaceId)) {
      pushIssue(issues, job.id, 'MISSING_WORKSPACE', 'Automation job has no primary workspace.');
    } else if (!hasValue(job.workspaceFound)) {
      pushIssue(issues, job.id, 'WORKSPACE_NOT_FOUND', 'Automation workspace no longer exists.');
    } else {
      const expectedWorkspaceTypes = scope === 'personal'
        ? new Set(['personal'])
        : new Set(['organization', 'team']);
      if (!expectedWorkspaceTypes.has(job.workspaceType ?? '') || !expectedWorkspaceTypes.has(job.actualWorkspaceType ?? '')) {
        pushIssue(issues, job.id, 'WORKSPACE_TYPE_MISMATCH', 'Automation scope and workspace type disagree.');
      }
      if (hasValue(job.organizationId) && job.actualWorkspaceOrganizationId !== job.organizationId) {
        pushIssue(issues, job.id, 'WORKSPACE_ORGANIZATION_MISMATCH', 'Automation workspace belongs to another organization.');
      }
    }

    if (scope === 'personal') {
      if (!hasValue(job.ownerUserId)) {
        pushIssue(issues, job.id, 'MISSING_OWNER', 'Personal automation has no owner.');
      }
      if (hasValue(job.ownerUserId) && job.responsibleUserId !== job.ownerUserId) {
        pushIssue(issues, job.id, 'RESPONSIBLE_OWNER_MISMATCH', 'Personal automation responsible user must equal owner.');
      }
      if (hasValue(job.serviceActorId)) {
        pushIssue(issues, job.id, 'UNEXPECTED_PERSONAL_SERVICE_ACTOR', 'Personal automation must not use a service actor.');
      }
      if (hasValue(job.approvedByUserId)) {
        pushIssue(issues, job.id, 'UNEXPECTED_PERSONAL_APPROVAL', 'Personal automation must not have organization approval.');
      }
      continue;
    }

    if (hasValue(job.ownerUserId)) {
      pushIssue(issues, job.id, 'UNEXPECTED_ORGANIZATION_OWNER', 'Organization automation must not retain a personal owner.');
    }
    if (!hasValue(job.responsibleUserId)) {
      pushIssue(issues, job.id, 'MISSING_RESPONSIBLE_USER', 'Organization automation has no responsible user.');
    }
    if (!hasValue(job.serviceActorId)) {
      pushIssue(issues, job.id, 'MISSING_SERVICE_ACTOR', 'Organization automation has no service actor.');
    }
    if (!hasValue(job.approvedByUserId)) {
      pushIssue(issues, job.id, 'MISSING_ORGANIZATION_APPROVAL', 'Organization automation has no approval actor.');
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    totalJobs: rows.length,
    affectedJobIds: Array.from(new Set(issues.map((issue) => issue.jobId))).sort(),
    issues,
  };
}
