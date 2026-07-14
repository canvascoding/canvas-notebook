import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

const navigation = read('app/components/settings/SettingsNavigation.tsx');
const settingsClient = read('app/components/settings/IntegrationsSettingsClient.tsx');
const agentSettings = read('app/components/settings/AgentSettingsPanel.tsx');
const runtimeCard = read('app/components/settings/AgentRuntimePreferenceCard.tsx');
const chatComposer = read('app/components/canvas-agent-chat/ChatComposer.tsx');
const onboardingWizard = read('app/[locale]/(routes)/onboarding/onboarding-wizard.tsx');

assert.doesNotMatch(navigation, /value:\s*['"]my-agent-runtime['"]/u);
assert.doesNotMatch(navigation, /\|\s*['"]my-agent-runtime['"]/u);
assert.match(settingsClient, /value === ['"]my-agent-runtime['"]\) return ['"]agent-settings['"]/u);
assert.doesNotMatch(settingsClient, /renderLazyTabContent\(['"]my-agent-runtime['"]/u);
assert.doesNotMatch(settingsClient, /import\(['"]@\/app\/components\/settings\/MyAgentRuntimePanel['"]\)/u);
assert.match(agentSettings, /<AgentRuntimePreferenceCard/u);
assert.match(agentSettings, /searchParams\.get\(['"]tab['"]\) === ['"]my-agent-runtime['"] \? ['"]runtime['"] : null/u);
assert.match(runtimeCard, /data-testid="agent-runtime-provider"/u);
assert.match(runtimeCard, /data-testid="agent-runtime-model"/u);
assert.match(runtimeCard, /data-testid="agent-runtime-thinking"/u);
assert.match(chatComposer, /href="\/settings\?tab=agent-settings&panel=runtime"/u);
assert.doesNotMatch(chatComposer, /tab=my-agent-runtime/u);
assert.doesNotMatch(onboardingWizard, /PersonalRuntimeStep/u);
assert.doesNotMatch(onboardingWizard, /step === ['"]runtime['"]/u);
assert.doesNotMatch(onboardingWizard, /MyAgentRuntimePanel/u);
assert.match(onboardingWizard, /USER_STEPS[^\n]+\['language', 'workspace', 'profile', 'tour', 'done'\]/u);

console.log('agent-runtime-settings-ui-test: ok');
