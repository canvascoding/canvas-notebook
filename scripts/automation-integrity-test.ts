import assert from 'node:assert/strict';

import {
  inspectAutomationIntegrity,
  type AutomationIntegrityRow,
} from '../app/lib/automations/integrity-model';

const validPersonal: AutomationIntegrityRow = {
  id: 'job-personal',
  scope: 'personal',
  organizationId: 'org-1',
  workspaceId: 'ws-personal',
  workspaceType: 'personal',
  ownerUserId: 'user-1',
  responsibleUserId: 'user-1',
  serviceActorId: null,
  approvedByUserId: null,
  workspaceFound: 'ws-personal',
  actualWorkspaceType: 'personal',
  actualWorkspaceOrganizationId: 'org-1',
};

const validOrganization: AutomationIntegrityRow = {
  id: 'job-organization',
  scope: 'organization',
  organizationId: 'org-1',
  workspaceId: 'ws-team',
  workspaceType: 'team',
  ownerUserId: null,
  responsibleUserId: 'user-admin',
  serviceActorId: 'org-service:org-1',
  approvedByUserId: 'user-admin',
  workspaceFound: 'ws-team',
  actualWorkspaceType: 'team',
  actualWorkspaceOrganizationId: 'org-1',
};

const report = inspectAutomationIntegrity([
  validPersonal,
  validOrganization,
  {
    ...validPersonal,
    id: 'job-broken-personal',
    ownerUserId: null,
    responsibleUserId: 'user-2',
    serviceActorId: 'org-service:org-1',
    workspaceFound: null,
  },
  {
    ...validOrganization,
    id: 'job-broken-organization',
    ownerUserId: 'user-admin',
    responsibleUserId: null,
    serviceActorId: null,
    approvedByUserId: null,
    workspaceType: 'personal',
    actualWorkspaceType: 'personal',
    actualWorkspaceOrganizationId: 'org-other',
  },
  {
    ...validPersonal,
    id: 'job-invalid-scope',
    scope: 'legacy',
  },
]);

assert.equal(report.totalJobs, 5);
assert.deepEqual(report.affectedJobIds, [
  'job-broken-organization',
  'job-broken-personal',
  'job-invalid-scope',
]);
assert.ok(report.issues.some((issue) => issue.code === 'MISSING_OWNER'));
assert.ok(report.issues.some((issue) => issue.code === 'WORKSPACE_NOT_FOUND'));
assert.ok(report.issues.some((issue) => issue.code === 'UNEXPECTED_ORGANIZATION_OWNER'));
assert.ok(report.issues.some((issue) => issue.code === 'MISSING_RESPONSIBLE_USER'));
assert.ok(report.issues.some((issue) => issue.code === 'MISSING_SERVICE_ACTOR'));
assert.ok(report.issues.some((issue) => issue.code === 'MISSING_ORGANIZATION_APPROVAL'));
assert.ok(report.issues.some((issue) => issue.code === 'WORKSPACE_TYPE_MISMATCH'));
assert.ok(report.issues.some((issue) => issue.code === 'WORKSPACE_ORGANIZATION_MISMATCH'));
assert.ok(report.issues.some((issue) => issue.code === 'INVALID_SCOPE'));

console.log('automation-integrity-test: ok');
