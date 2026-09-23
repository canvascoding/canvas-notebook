import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  DEFAULT_PI_CONFIG,
  normalizePiRuntimeConfig,
  parsePiCompactionSummaryModelIdentity,
  validatePiConfig,
} from '../app/lib/pi/config';
import { resolvePiEffectiveCompactionPolicy } from '../app/lib/pi/compaction/runtime-policy';
import { resolvePiCompactionEditableSettings } from '../app/lib/pi/compaction/settings-service';

const identity = 'aip_0123456789abcdef01234567/anthropic/claude-sonnet';
assert.deepEqual(parsePiCompactionSummaryModelIdentity(identity), {
  providerInstallationId: 'aip_0123456789abcdef01234567',
  modelId: 'anthropic/claude-sonnet',
});
assert.equal(parsePiCompactionSummaryModelIdentity('provider-only'), null);
assert.equal(parsePiCompactionSummaryModelIdentity('aip_123/'), null);
assert.equal(parsePiCompactionSummaryModelIdentity('aip_123/model with spaces'), null);
assert.match(
  validatePiConfig({
    ...structuredClone(DEFAULT_PI_CONFIG),
    compaction: { tailMode: 'lean', summaryModel: 'provider-only' },
  }) || '',
  /providerInstallationId\/modelId/u,
);
assert.deepEqual(
  normalizePiRuntimeConfig({
    ...structuredClone(DEFAULT_PI_CONFIG),
    compaction: { tailMode: 'lean', summaryModel: 'provider-only' },
  }).compaction,
  { tailMode: 'lean' },
);

const safeFallback = resolvePiEffectiveCompactionPolicy({
  runtimeConfig: {
    ...structuredClone(DEFAULT_PI_CONFIG),
    compaction: { tailMode: 'lean', summaryModel: identity },
  },
  environment: { CANVAS_PI_COMPACTION_SUMMARY_MODEL: 'not-a-catalog-identity' },
});
assert.equal(safeFallback.summaryModel, identity, 'an invalid environment identity must not displace a valid persisted one');

const organizationExplicitMain = resolvePiEffectiveCompactionPolicy({
  runtimeConfig: {
    ...structuredClone(DEFAULT_PI_CONFIG),
    compaction: { tailMode: 'lean', summaryModel: identity },
  },
  organizationConfig: { configured: true, tailMode: 'legacy', summaryModel: null },
  environment: {},
});
assert.equal(organizationExplicitMain.summaryModel, null,
  'an organization explicitly selecting the main model must not fall back to a global legacy summary model');
assert.equal(organizationExplicitMain.sources.summaryModel, 'persisted',
  'an organization explicitly selecting the main model must be reported as a persisted decision');

const firstOrganizationSave = resolvePiCompactionEditableSettings({
  configured: false,
  persisted: { tailMode: null, summaryModel: null },
  effective: { tailMode: 'lean', summaryModel: identity },
});
assert.deepEqual(firstOrganizationSave, { tailMode: 'lean', summaryModel: identity },
  'the first organization save must retain a safe legacy summary route as the editable value');

const explicitOrganizationMain = resolvePiCompactionEditableSettings({
  configured: true,
  persisted: { tailMode: 'legacy', summaryModel: null },
  effective: { tailMode: 'legacy', summaryModel: identity },
});
assert.deepEqual(explicitOrganizationMain, { tailMode: 'legacy', summaryModel: null },
  'a configured organization must retain its explicit main-model choice');

const routeSource = fs.readFileSync('app/api/admin/agent-runtime/compaction/route.ts', 'utf8');
assert.match(routeSource, /requireInstanceAdmin/u);
assert.match(routeSource, /readOrganizationPermissionForUser/u);
assert.match(routeSource, /expectedCatalogRevision/u);
assert.match(routeSource, /expectedSettingsRevision/u);
assert.match(routeSource, /updatePiCompactionAdminSettings/u);
assert.match(routeSource, /recordAuditEvent/u);

const serviceSource = fs.readFileSync('app/lib/pi/compaction/settings-service.ts', 'utf8');
assert.match(serviceSource, /readPiRuntimeConfig/u);
assert.match(serviceSource, /writePiOrganizationCompactionSettings/u);
assert.doesNotMatch(serviceSource, /writePiRuntimeConfig/u,
  'new organization settings must not overwrite the instance-wide legacy PI config');
assert.match(serviceSource, /resolvePiEffectiveCompactionPolicy/u);
assert.match(serviceSource, /SUMMARY_MODEL_UNAVAILABLE/u);
assert.match(serviceSource, /createSessionCompactionBudget/u);
assert.match(serviceSource, /resolvePiCompactionEditableSettings/u);

const componentSource = fs.readFileSync('app/components/settings/PiCompactionSettingsPanel.tsx', 'utf8');
assert.match(componentSource, /\/api\/admin\/agent-runtime\/compaction/u);
assert.match(componentSource, /data-testid="pi-compaction-tail-mode"/u);
assert.match(componentSource, /data-testid="pi-compaction-summary-model"/u);
assert.match(componentSource, /disabled=\{saving \|\| tailLocked\}/u);
assert.match(componentSource, /disabled=\{saving \|\| summaryLocked\}/u);
assert.match(componentSource, /pi-compaction-configuration/u);
assert.match(componentSource, /pi-compaction-runtime-preview/u);
assert.match(componentSource, /payload\.data\.editable\.summaryModel/u);

const hostSource = fs.readFileSync('app/components/settings/AiProvidersModelsPanel.tsx', 'utf8');
assert.match(hostSource, /<PiCompactionSettingsPanel locale=\{locale\} \/>/u);
assert.match(componentSource, /useTranslations\('settings\.compaction'\)/u);

const enSettings = JSON.parse(fs.readFileSync('messages/en.json', 'utf8')) as { settings: { compaction?: Record<string, string> } };
const deSettings = JSON.parse(fs.readFileSync('messages/de.json', 'utf8')) as { settings: { compaction?: Record<string, string> } };
for (const key of ['title', 'mode', 'summaryModel', 'requestBoundary', 'sourceEnvironment']) {
  assert.ok(enSettings.settings.compaction?.[key], `missing English compaction setting translation: ${key}`);
  assert.ok(deSettings.settings.compaction?.[key], `missing German compaction setting translation: ${key}`);
}

const runtimeStatusSource = fs.readFileSync('app/lib/chat/runtime-status.ts', 'utf8');
const liveRuntimeSource = fs.readFileSync('app/lib/pi/live-runtime.ts', 'utf8');
const runtimeServiceSource = fs.readFileSync('app/lib/pi/runtime-service.ts', 'utf8');
const contextDetailsSource = fs.readFileSync('app/components/canvas-agent-chat/ContextMeasurementDetails.tsx', 'utf8');
assert.match(runtimeStatusSource, /RuntimeCompactionPolicyStatus/u);
assert.match(liveRuntimeSource, /runtimeCompactionPolicyStatus/u);
assert.match(liveRuntimeSource, /activeSummaryModel: compactionSummaryRuntime\?\.identity \?\? null/u);
assert.match(contextDetailsSource, /context-compaction-policy-details/u);
assert.match(runtimeServiceSource, /await runtimeInstance\.reloadCompactionPolicyForNextRequest\(\)/u,
  'the interactive request path must rebind policy only before an idle prompt begins');
assert.match(liveRuntimeSource, /this\.isRunning\s*\|\|[\s\S]{0,160}this\.pendingReplace !== null/u,
  'the policy refresh must refuse streaming and queued turns');

console.log('pi-compaction-settings-contract-test: ok');
