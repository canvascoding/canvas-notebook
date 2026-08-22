import assert from 'node:assert/strict';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  appendEffectiveToolCapabilitiesPrompt,
  buildEffectiveToolCapabilitiesPrompt,
  buildEffectiveToolManifest,
  EFFECTIVE_TOOL_CAPABILITIES_MARKER,
  effectiveToolManifestHas,
} from '../app/lib/pi/effective-tool-manifest';

function tool(name: string, description = `${name} description`): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: {} as AgentTool['parameters'],
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  } as AgentTool;
}

const empty = buildEffectiveToolManifest([]);
assert.deepEqual(empty.registeredToolNames, []);
assert.match(buildEffectiveToolCapabilitiesPrompt(empty), new RegExp(EFFECTIVE_TOOL_CAPABILITIES_MARKER));
assert.match(buildEffectiveToolCapabilitiesPrompt(empty), /No runtime tools are available/);
assert.doesNotMatch(buildEffectiveToolCapabilitiesPrompt(empty), /`read`/);
assert.doesNotMatch(buildEffectiveToolCapabilitiesPrompt(empty), /`bash`/);

const direct = buildEffectiveToolManifest([tool('read'), tool('email_read_message')]);
assert.deepEqual(direct.registeredToolNames, ['read', 'email_read_message']);
assert.equal(effectiveToolManifestHas(direct, 'read'), true);
assert.equal(effectiveToolManifestHas(direct, 'write'), false);
const directPrompt = buildEffectiveToolCapabilitiesPrompt(direct);
assert.match(directPrompt, /`read`/);
assert.match(directPrompt, /`email_read_message`/);
assert.match(directPrompt, /Attachments and workspace reading/);
assert.match(directPrompt, /Email safety/);
assert.doesNotMatch(directPrompt, /`write`/);
assert.doesNotMatch(directPrompt, /MCP gateway/);

const gateway = {
  ...tool('studio', 'Studio gateway'),
  label: 'Studio',
  progressiveGateway: {
    operations: [tool('studio_generate_image'), tool('studio_list_presets')],
  },
} as AgentTool;
const gatewayManifest = buildEffectiveToolManifest([gateway]);
assert.deepEqual(gatewayManifest.registeredToolNames, ['studio']);
assert.deepEqual(gatewayManifest.gateways[0]?.allowedOperationNames, ['studio_generate_image', 'studio_list_presets']);
assert.equal(effectiveToolManifestHas(gatewayManifest, 'studio_generate_image'), true);
const gatewayPrompt = buildEffectiveToolCapabilitiesPrompt(gatewayManifest);
assert.match(gatewayPrompt, /`studio`/);
assert.match(gatewayPrompt, /studio_generate_image, studio_list_presets/);
assert.doesNotMatch(gatewayPrompt, /`studio_generate_image` \[Studio\]/);

assert.equal(buildEffectiveToolManifest([tool('read')]).revision, buildEffectiveToolManifest([tool('read')]).revision);
assert.notEqual(buildEffectiveToolManifest([tool('read')]).revision, buildEffectiveToolManifest([tool('write')]).revision);
assert.match(appendEffectiveToolCapabilitiesPrompt('Foundation', direct), /^Foundation\n\n<!-- canvas-effective-tools:v1 -->/);

console.log('effective-tool-manifest-test: ok');
