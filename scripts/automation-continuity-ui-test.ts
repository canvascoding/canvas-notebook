import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  selectEligibleAutomationSources,
  toggleAutomationSourceSelection,
} from '../app/apps/automations/components/automation-continuity-ui';
import type { AutomationJobRecord } from '../app/lib/automations/types';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

type Candidate = Pick<AutomationJobRecord,
  'id' | 'name' | 'status' | 'integrityStatus' | 'scope' | 'organizationId'
  | 'workspaceId' | 'workspaceType' | 'ownerUserId' | 'createdByUserId'>;

const team = {
  id: 'workspace-a', type: 'organization', organizationId: 'org-a',
} as ClientWorkspaceSummary;
const source = (id: string, patch: Partial<Candidate> = {}): Candidate => ({
  id, name: id, status: 'active', integrityStatus: 'valid', scope: 'organization',
  organizationId: 'org-a', workspaceId: 'workspace-a', workspaceType: 'organization',
  ownerUserId: null, createdByUserId: 'alice', ...patch,
});

const eligible = selectEligibleAutomationSources([
  source('target'), source('valid'),
  source('other-workspace', { workspaceId: 'workspace-b' }),
  source('other-org', { organizationId: 'org-b' }),
  source('paused', { status: 'paused' }),
  source('invalid', { integrityStatus: 'quarantined' }),
], team, 'target');
assert.deepEqual(eligible.map((job) => job.id), ['valid']);
assert.deepEqual(selectEligibleAutomationSources([source('valid')], null, null), []);

const personal = {
  id: 'personal-a', type: 'personal', ownerUserId: 'alice', organizationId: null,
} as ClientWorkspaceSummary;
assert.deepEqual(selectEligibleAutomationSources([
  source('owned', { scope: 'personal', organizationId: null, workspaceId: 'personal-a',
    workspaceType: 'personal', ownerUserId: 'alice' }),
  source('other-owner', { scope: 'personal', organizationId: null, workspaceId: 'personal-a',
    workspaceType: 'personal', ownerUserId: 'bob' }),
], personal, null).map((job) => job.id), ['owned']);

assert.deepEqual(toggleAutomationSourceSelection([], 'a'), ['a']);
assert.deepEqual(toggleAutomationSourceSelection(['a', 'b', 'c'], 'd'), ['a', 'b', 'c']);
assert.deepEqual(toggleAutomationSourceSelection(['a', 'b', 'c'], 'b'), ['a', 'c']);

for (const locale of ['en', 'de']) {
  const messages = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'));
  const continuity = messages.automationen.continuity;
  assert.equal(typeof continuity.mode.last_relevant, 'string');
  assert.equal(typeof continuity.state.reveal, 'string');
  assert.equal(typeof continuity.state.reset, 'string');
  assert.equal(typeof continuity.state.resetReadOnly, 'string');
  assert.equal(typeof continuity.run.tokens, 'string');
}

console.log('Automation continuity UI selection and translations: passed');
