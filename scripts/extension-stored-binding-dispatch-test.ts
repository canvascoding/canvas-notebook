import assert from 'node:assert/strict';

import { parseStoredAgentWorkflowPackage, type StoredAgentWorkflowPackage } from '../app/lib/agents/workflow-contracts';
import { parseStoredAgentWorkflowHeader, type AgentWorkflowVersion } from '../app/lib/agents/workflow-version';
import { EXTENSION_SELECTION_LIMITS, extensionSelectionEntrySchema } from '../app/lib/capabilities/extensions/contracts';
import { decodeStoredAgentExtensionBinding, assertStoredAgentExtensionBindingsMatchHeader } from '../app/lib/capabilities/extensions/stored-binding-dispatch';
import { parseStoredPackageExtensionBinding, type StoredPackageExtensionSelectionEntry } from '../app/lib/capabilities/extensions/stored-package-contracts';
import { createStandaloneExtensionSlotRef } from '../app/lib/capabilities/extensions/standalone-reference';

const packageRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const secondPackageRef = 'canvas-resource:22222222-2222-4222-8222-222222222222';
const revisionRef = 'canvas-package-revision:33333333-3333-4333-8333-333333333333';
const newerRevisionRef = 'canvas-package-revision:44444444-4444-4444-8444-444444444444';
const connectionRef = 'canvas-connection:55555555-5555-4555-8555-555555555555';
const pin = {resourceRef: packageRef, publishedRevisionRef: revisionRef, checksum: 'a'.repeat(64)};
const pluginWorkflow: StoredAgentWorkflowPackage = {version: 1, ...pin, skillSelection: {kind: 'plugin'},
  selectedSkills: [{name: 'brief', relativeRoot: 'skills/brief'}, {name: 'assets', relativeRoot: 'skills/assets'}], declarations: []};
const skillWorkflow: StoredAgentWorkflowPackage = {version: 1, ...pin, resourceRef: secondPackageRef,
  skillSelection: {kind: 'skills', relativeRoots: ['']}, selectedSkills: [{name: 'independent-brief', relativeRoot: ''}], declarations: []};
const parentSelection: StoredPackageExtensionSelectionEntry = {selection: {kind: 'plugin', package: pin,
  skillSelection: {kind: 'all'}}, requirement: 'required', toolCap: null};
const childSelection: StoredPackageExtensionSelectionEntry = {selection: {kind: 'skill', package: pin,
  origin: 'plugin_child', relativeRoot: 'skills/brief'}, requirement: 'optional', toolCap: []};
const pluginWrapper = {version: 2, kind: 'package', workflow: pluginWorkflow, selections: [parentSelection]};
const skillWrapper = {version: 2, kind: 'package', workflow: skillWorkflow, selections: [{selection: {kind: 'skill',
  package: {...pin, resourceRef: secondPackageRef}, origin: 'standalone', relativeRoot: ''}, requirement: 'optional', toolCap: []}]};
const sharedMcp = {version: 1, kind: 'standalone', configurationId: 'mcp-slot', mode: 'fixed', entry: {
  selection: {kind: 'mcp', source: 'mcp', target: {kind: 'shared', connectionRef, bindingRevision: 3}},
  target: {kind: 'shared', source: 'mcp', connectionRef, bindingRevision: 3}, requirement: 'required', toolCap: ['READ'],
}};
const sharedComposio = {version: 1, kind: 'standalone', configurationId: 'composio-slot', mode: 'fixed', entry: {
  selection: {kind: 'composio', source: 'composio', toolkit: 'canva', target: {kind: 'shared', connectionRef, bindingRevision: 3}},
  target: {kind: 'shared', source: 'composio', connectionRef, bindingRevision: 3}, requirement: 'optional', toolCap: null,
}};
const mcpSlotRef = createStandaloneExtensionSlotRef({configurationId: sharedMcp.configurationId, source: 'mcp'});
const composioSlotRef = createStandaloneExtensionSlotRef({configurationId: sharedComposio.configurationId, source: 'composio', toolkit: 'canva'});
let rejectedProtocols = 0;

function expectStoredDispatchCorrupt(operation: () => unknown, message: string) {
  assert.throws(operation, {code: 'AGENT_WORKFLOW_CORRUPT', status: 409}, message);
  rejectedProtocols += 1;
}
function encodeStoredDispatch(value: unknown) { return JSON.stringify(value); }
function storedDispatchRow(resourceType: 'plugin' | 'skill' | 'connection', value: unknown, resourceId: string) {
  return {...decodeStoredAgentExtensionBinding(resourceType, value === null ? null : encodeStoredDispatch(value)), resourceType, resourceId};
}

function runStoredBindingDispatchProtocolProof() {
  // SQL NULL alone retains legacy inheritance, regardless of legacy row type.
  const inherited = (['plugin', 'skill', 'connection'] as const).map((type, index) => storedDispatchRow(type, null, `legacy-row-${index}`));
  assertStoredAgentExtensionBindingsMatchHeader(null, inherited);
  for (const row of inherited) assert.deepEqual(decodeStoredAgentExtensionBinding(row.resourceType, null), {configuration: null, extensionFormatVersion: null});

  const v1Plugin = storedDispatchRow('plugin', pluginWorkflow, '11111111-1111-4111-8111-111111111111');
  const v1Skill = storedDispatchRow('skill', skillWorkflow, '22222222-2222-4222-8222-222222222222');
  const legacyConnection = storedDispatchRow('connection', null, 'connection:Legacy named connector');
  assertStoredAgentExtensionBindingsMatchHeader(1, [v1Plugin, v1Skill, legacyConnection]);
  assert.deepEqual(v1Plugin.configuration, parseStoredAgentWorkflowPackage(pluginWorkflow), 'V1 private codec behavior remains unchanged.');
  assert.deepEqual(v1Plugin.configuration, pluginWorkflow, 'The exact V1 resource/revision/checksum and child index survive decoding.');
  assert.equal(v1Plugin.extensionFormatVersion, 1); assert.equal(v1Plugin.extensionSelections, undefined);
  assert.equal(legacyConnection.extensionFormatVersion, null);

  const v2Plugin = storedDispatchRow('plugin', pluginWrapper, v1Plugin.resourceId);
  const v2Skill = storedDispatchRow('skill', skillWrapper, v1Skill.resourceId);
  const v2Mcp = storedDispatchRow('connection', sharedMcp, mcpSlotRef);
  const v2Composio = storedDispatchRow('connection', sharedComposio, composioSlotRef);
  assertStoredAgentExtensionBindingsMatchHeader(2, [v2Plugin, v2Skill, v2Mcp, v2Composio]);
  assert.deepEqual(v2Plugin.configuration, pluginWorkflow, 'V2 wraps the nested V1 workflow instead of upgrading or repinning it.');
  assert.deepEqual(v2Plugin.extensionSelections, [parentSelection]);
  assert.equal(v2Mcp.extensionFormatVersion, 2); assert.equal(v2Mcp.configuration, null);
  assert.deepEqual(v2Mcp.standaloneConfiguration, sharedMcp);
  assert.deepEqual(v2Composio.standaloneConfiguration, sharedComposio);
  assert(v2Plugin.configuration && Object.isFrozen(v2Plugin.extensionSelections));

  const emptyMask = {...pluginWrapper, selections: [{...parentSelection,
    selection: {...parentSelection.selection, skillSelection: {kind: 'subset', relativeRoots: []}}}]};
  const emptyChildMask = storedDispatchRow('plugin', emptyMask, v1Plugin.resourceId);
  assertStoredAgentExtensionBindingsMatchHeader(2, [emptyChildMask]);
  assert.deepEqual(emptyChildMask.configuration, pluginWorkflow, 'An explicit empty child mask retains the held parent workflow and full declaration scope.');
  assert.deepEqual(emptyChildMask.extensionSelections, emptyMask.selections);
  const withExplicitChild = storedDispatchRow('plugin', {...pluginWrapper, selections: [parentSelection, childSelection]}, v1Plugin.resourceId);
  assertStoredAgentExtensionBindingsMatchHeader(2, [withExplicitChild]);
  assert.deepEqual(withExplicitChild.extensionSelections, [parentSelection, childSelection], 'Parent and explicit child belong in one canonical package row.');
  assert.deepEqual(parseStoredPackageExtensionBinding(pluginWrapper).workflow, pluginWorkflow);

  // An explicit empty V2 configuration is not SQL NULL inheritance: the header remains 2.
  for (const version of [null, 1, 2] as const) assertStoredAgentExtensionBindingsMatchHeader(version, []);
  assert.deepEqual(parseStoredAgentWorkflowHeader(2, 1), {workflowVersion: 2, workflowRevision: 1});
  assert.deepEqual(parseStoredAgentWorkflowHeader(null, 0), {workflowVersion: null, workflowRevision: 0});
  for (const unknownHeader of [undefined, 0, 3, -1, '1', '2', true, NaN, Infinity, {}]) {
    expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(unknownHeader as AgentWorkflowVersion, []), 'Unsupported headers cannot pass just because there are no rows.');
  }

  for (const row of [v1Plugin, v2Plugin, v2Mcp]) expectStoredDispatchCorrupt(
    () => assertStoredAgentExtensionBindingsMatchHeader(null, [row]), 'A private payload cannot coexist with the inheritance header.');
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(2, [v1Plugin]), 'V2 package rows require a real V2 wrapper.');
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(1, [v2Plugin]), 'A V2 wrapper is not implicitly downgraded to V1.');
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(1, [v2Mcp]), 'V1 never executes standalone extension slots.');
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(1, [inherited[0]!]), 'Explicit V1 package rows cannot silently inherit.');
  for (const row of inherited) expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(2, [row]), 'Every V2 row has an explicit supported private format.');

  // Untrusted SQL bytes must not migrate through a permissive legacy fallback.
  for (const type of [undefined, null, 1, '', 'mcp', 'integration', 'Plugin']) {
    expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding(type, null), 'Unknown resource kinds are rejected even with SQL NULL.');
  }
  for (const type of ['plugin', 'skill', 'connection']) {
    for (const bytes of [undefined, {}, [], 1, '', '{', '[}', 'null', '[]', 'true', '123', '"display-name"']) {
      expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding(type, bytes), 'Only supported JSON object bytes or actual SQL NULL are accepted.');
    }
    expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding(type, 'x'.repeat(EXTENSION_SELECTION_LIMITS.bytes + 1)), 'The byte budget is checked before parsing oversized storage.');
    expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding(type, `"${'😀'.repeat(EXTENSION_SELECTION_LIMITS.bytes / 4)}"`), 'UTF-8 bytes, not JavaScript character count, enforce the bound.');
  }
  const manyRoots = Array.from({length: 17}, (_, index) => `skills/bounded-${index}`);
  const individuallyBoundedCaps = Array.from({length: EXTENSION_SELECTION_LIMITS.tools}, (_, index) => `TOOL_${index}_`.padEnd(256, 'x'));
  const aggregateByteFixture = {version: 2, kind: 'package', workflow: {...pluginWorkflow,
    skillSelection: {kind: 'skills', relativeRoots: manyRoots}, selectedSkills: manyRoots.map((relativeRoot, index) => ({name: `bounded-${index}`, relativeRoot}))},
  selections: manyRoots.map(relativeRoot => ({selection: {kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot},
    requirement: 'optional', toolCap: individuallyBoundedCaps}))};
  assert(manyRoots.length < EXTENSION_SELECTION_LIMITS.children);
  for (const entry of aggregateByteFixture.selections) assert(extensionSelectionEntrySchema.safeParse(entry).success, 'Every selection and cap fits its individual public field limits.');
  assert.doesNotThrow(() => parseStoredPackageExtensionBinding({...aggregateByteFixture,
    selections: aggregateByteFixture.selections.map(entry => ({...entry, toolCap: []}))}), 'The exact child origins, pin and workflow mask are otherwise valid.');
  const oversizedValidJson = encodeStoredDispatch(aggregateByteFixture);
  assert(Buffer.byteLength(oversizedValidJson) > EXTENSION_SELECTION_LIMITS.bytes);
  expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding('plugin', oversizedValidJson), 'Individually valid selections cannot bypass the aggregate storage byte budget.');
  expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding('skill', encodeStoredDispatch(pluginWrapper)), 'A plugin parent cannot be disguised as a standalone skill row.');
  expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding('connection', encodeStoredDispatch(pluginWrapper)), 'Connection rows cannot contain package wrappers.');
  expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding('plugin', encodeStoredDispatch(sharedMcp)), 'Package rows cannot contain standalone connection payloads.');
  for (const [resourceType, unsupported] of [
    ['plugin', {...pluginWrapper, version: 3}], ['plugin', {...pluginWrapper, kind: 'unknown'}],
    ['connection', {...sharedMcp, kind: 'unknown'}], ['connection', {...sharedMcp, version: 2}],
    ['plugin', {...pluginWrapper, unknownField: true}], ['plugin', {...pluginWrapper, workflow: {...pluginWorkflow, unknownField: true}}],
    ['plugin', {...pluginWrapper, workflow: {...pluginWorkflow, version: 2}}], ['connection', {...sharedMcp, unknownField: true}],
  ] as const) {
    expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding(resourceType, encodeStoredDispatch(unsupported)), 'Unknown versions, kinds and fields cannot be tolerated.');
  }
  const receipt = `cmp_personal_account_${'A'.repeat(48)}`;
  expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding('plugin', encodeStoredDispatch({...pluginWrapper,
    selections: [{...parentSelection, accountSelectionRef: receipt}]})), 'A transient account receipt never becomes a durable package selection.');
  expectStoredDispatchCorrupt(() => decodeStoredAgentExtensionBinding('connection', encodeStoredDispatch({...sharedMcp,
    entry: {...sharedMcp.entry, accountSelectionRef: receipt}})), 'Standalone storage cannot retain an intake receipt.');

  // Aggregate identity matters even when each individual payload is valid.
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(1, [v1Plugin, {...v1Plugin, resourceId: 'different-storage-row'}]), 'Duplicate canonical package references are rejected independently of storage row IDs.');
  const newerV1 = storedDispatchRow('plugin', {...pluginWorkflow, publishedRevisionRef: newerRevisionRef}, 'different-storage-row');
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(1, [v1Plugin, newerV1]), 'Two held revisions cannot become duplicate package rows in one agent configuration.');
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(2, [v2Plugin, withExplicitChild]), 'V2 parent/child selections must share their one package row.');
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(2, [v2Mcp, v2Mcp]), 'Repeated standalone slots are rejected.');
  const duplicateConfigId = {...sharedComposio, configurationId: sharedMcp.configurationId};
  const differentSourceSlot = createStandaloneExtensionSlotRef({configurationId: duplicateConfigId.configurationId, source: 'composio', toolkit: 'canva'});
  assert.notEqual(differentSourceSlot, mcpSlotRef);
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(2, [v2Mcp,
    storedDispatchRow('connection', duplicateConfigId, differentSourceSlot)]), 'Configuration IDs remain unique even across different source-specific slot hashes.');
  for (const misleadingId of [connectionRef, composioSlotRef, 'agent-extension:not-a-current-slot',
    createStandaloneExtensionSlotRef({configurationId: sharedMcp.configurationId, source: 'composio', toolkit: 'canva'})]) {
    expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(2, [{...v2Mcp, resourceId: misleadingId}]), 'The stored row ID must be derived from this exact configuration ID and source.');
  }
  expectStoredDispatchCorrupt(() => assertStoredAgentExtensionBindingsMatchHeader(2, [{...v2Composio,
    resourceId: createStandaloneExtensionSlotRef({configurationId: sharedComposio.configurationId, source: 'composio', toolkit: 'slack'})}]), 'An exact Composio toolkit is part of slot identity.');
  console.log(`PASS stored extension binding dispatch: V1 pins unchanged; explicit V2 and nested V1; SQL NULL inheritance; exact shared slot identities; ${rejectedProtocols} corrupt protocol cases rejected; no authority/provider operations.`);
}

runStoredBindingDispatchProtocolProof();
