import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

const agentGrants = read('app/components/agents/AgentGrantsEditor.tsx');
const capabilityPolicies = read('app/components/settings/SkillsPanel.tsx');
const policyRoute = read('app/api/skills/policies/route.ts');
const agentGrantService = read('app/lib/agents/grants.ts');
const sharedPicker = read('app/components/organization/SearchablePolicyTargetPicker.tsx');

assert.match(agentGrants, /SearchablePolicyTargetPicker/u);
assert.match(capabilityPolicies, /SearchablePolicyTargetPicker/u);
assert.match(capabilityPolicies, /capability-policy-target-\$\{targetType\}-picker/u);
assert.match(capabilityPolicies, /setTargets\(policiesPayload\.targets \|\| EMPTY_POLICY_TARGETS\)/u);
assert.match(capabilityPolicies, /targetType === 'organization'/u);
assert.doesNotMatch(agentGrants, /function SearchableTargetPicker/u);
assert.match(sharedPicker, /role="combobox"/u);
assert.match(sharedPicker, /CommandInput/u);
assert.match(sharedPicker, /option\.description \|\| ''\} \$\{option\.id\}/u);
assert.match(policyRoute, /listOrganizationPolicyTargets/u);
assert.match(policyRoute, /success: true, policies, targets/u);
assert.match(agentGrantService, /listAgentGrantTargets = listOrganizationPolicyTargets/u);

console.log('organization-policy-target-picker-ui-test: ok');
