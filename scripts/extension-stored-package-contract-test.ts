import assert from 'node:assert/strict';
import {
  parseStoredAgentWorkflowPackage,
  type StoredAgentWorkflowPackage,
} from '../app/lib/agents/workflow-contracts';
import {
  parseStoredPackageExtensionBinding,
  storedPackageExtensionBindingSchema,
} from '../app/lib/capabilities/extensions/stored-package-contracts';

const resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const publishedRevisionRef = 'canvas-package-revision:22222222-2222-4222-8222-222222222222';
const checksum = 'a'.repeat(64);
const pin = { resourceRef, publishedRevisionRef, checksum };

function packageDeclaration(declarationPath: string, capabilityId: string) {
  return {
    declarationPath,
    capabilities: [{
      capabilityId,
      required: true,
      application: 'canva',
      alternatives: [{ source: 'composio' as const, toolkit: 'canva', requiredTools: ['READ'] }],
      selection: {
        mode: 'fixed' as const,
        alternativeKey: 'composio:canva',
        target: { kind: 'shared' as const, source: 'composio' as const,
          connectionRef: 'canvas-connection:33333333-3333-4333-8333-333333333333', bindingRevision: 3 },
        toolCap: ['READ'],
      },
    }],
  };
}

const parentWorkflow: StoredAgentWorkflowPackage = {
  version: 1,
  ...pin,
  skillSelection: { kind: 'plugin' },
  selectedSkills: [
    { name: 'root-skill', relativeRoot: '' },
    { name: 'child-a', relativeRoot: 'skills/a' },
    { name: 'child-b', relativeRoot: 'skills/b' },
  ],
  declarations: [
    packageDeclaration('.canvas-plugin/plugin.json', 'parent-required'),
    packageDeclaration('agents/canvas.yaml', 'root-required'),
    packageDeclaration('skills/a/agents/canvas.yaml', 'a-required'),
    packageDeclaration('skills/b/agents/canvas.yaml', 'b-required'),
  ],
};

function pluginEntry(relativeRoots?: string[]) {
  return {
    selection: { kind: 'plugin', package: { ...pin },
      skillSelection: relativeRoots === undefined ? { kind: 'all' } : { kind: 'subset', relativeRoots } },
    requirement: 'required',
    toolCap: null,
  };
}

function skillEntry(relativeRoot: string, origin = 'plugin_child') {
  return {
    selection: { kind: 'skill', package: { ...pin }, origin, relativeRoot },
    requirement: 'optional',
    toolCap: [],
  };
}

function packageWrapper(selections: unknown[] = [pluginEntry()], workflow: StoredAgentWorkflowPackage = parentWorkflow) {
  return { version: 2, kind: 'package', workflow, selections };
}

function changedPackageFixture(value: unknown, fields: readonly (string | number)[], replacement: unknown): unknown {
  const copy = structuredClone(value);
  let current = copy as Record<string, unknown>;
  for (const field of fields.slice(0, -1)) current = current[field] as Record<string, unknown>;
  current[fields[fields.length - 1]] = replacement;
  return copy;
}

function invalidPackageFixture(value: unknown, message: string): void {
  assert.equal(storedPackageExtensionBindingSchema.safeParse(value).success, false, message);
  assert.throws(() => parseStoredPackageExtensionBinding(value), { code: 'AGENT_WORKFLOW_CORRUPT', status: 409 }, message);
}

const original = packageWrapper();
const encodedV1 = JSON.stringify(original.workflow);
const all = parseStoredPackageExtensionBinding(original);
assert.equal(all.version, 2);
assert.equal(all.kind, 'package');
assert.deepEqual(all.workflow, parentWorkflow);
assert.equal(JSON.stringify(all.workflow), JSON.stringify(parseStoredAgentWorkflowPackage(original.workflow)),
  'V2 keeps the original V1 codec output, including its existing normalization, without rewriting payload semantics.');
assert(Object.isFrozen(all));
assert(Object.isFrozen(all.workflow));
assert(Object.isFrozen(all.workflow.selectedSkills));
assert(Object.isFrozen(all.workflow.declarations[0].capabilities[0].selection));
assert(Object.isFrozen(all.selections));
assert(Object.isFrozen(all.selections[0].selection));
assert.equal(all.selections[0].toolCap, null);
assert.equal(Object.isFrozen(original.workflow), false, 'Freezing a validated copy never freezes the caller-owned workflow.');
const detached = structuredClone(original);
const frozenCopy = parseStoredPackageExtensionBinding(detached);
detached.workflow.selectedSkills[0].name = 'caller-mutated';
assert.equal(frozenCopy.workflow.selectedSkills[0].name, 'root-skill');

for (const entries of [
  [pluginEntry([''])],
  [pluginEntry(['skills/a'])],
  [pluginEntry(['skills/a']), skillEntry('skills/b')],
  [pluginEntry(['skills/a']), skillEntry('skills/a')],
  [pluginEntry(), skillEntry('')],
  [pluginEntry(), skillEntry('skills/a')],
  [pluginEntry([])],
  [pluginEntry([]), skillEntry('')],
]) {
  const wrapped = packageWrapper(entries);
  const parsed = parseStoredPackageExtensionBinding(wrapped);
  assert.deepEqual(parsed.selections, entries, 'The exact parent/subset/explicit-child inputs are retained for union-mask projection.');
  assert.deepEqual(parsed.workflow, parentWorkflow, 'The codec never filters V1 selectedSkills or removes parent/child declarations.');
  assert(parsed.workflow.declarations[0].capabilities[0].required, 'Parent requirements survive optional child exclusions.');
}
const rootChildWorkflow: StoredAgentWorkflowPackage = {
  ...pin, version: 1, skillSelection: { kind: 'skills', relativeRoots: [''] },
  selectedSkills: [{ name: 'root-skill', relativeRoot: '' }], declarations: [packageDeclaration('agents/canvas.yaml', 'root-required')],
};
assert.deepEqual(parseStoredPackageExtensionBinding(packageWrapper([skillEntry('')], rootChildWorkflow)).workflow,
  rootChildWorkflow, 'A declared plugin-root skill can preserve its exact child origin and empty relative root.');
assert.deepEqual(parseStoredPackageExtensionBinding(packageWrapper([skillEntry('', 'standalone')], rootChildWorkflow)).workflow,
  rootChildWorkflow, 'A standalone skill has an exact empty package root; actual artifact kind is an action authority check.');
const childWorkflow: StoredAgentWorkflowPackage = {
  ...pin, version: 1, skillSelection: { kind: 'skills', relativeRoots: ['skills/a', 'skills/b'] },
  selectedSkills: parentWorkflow.selectedSkills.slice(1), declarations: parentWorkflow.declarations.slice(2),
};
assert.deepEqual(parseStoredPackageExtensionBinding(packageWrapper([skillEntry('skills/a'), skillEntry('skills/b')], childWorkflow)).workflow, childWorkflow);
const singleChildWorkflow: StoredAgentWorkflowPackage = {
  ...pin, version: 1, childRelativeRoot: 'skills/a', skillSelection: { kind: 'skills', relativeRoots: ['skills/a'] },
  selectedSkills: [{ name: 'child-a', relativeRoot: 'skills/a' }], declarations: parentWorkflow.declarations.slice(2, 3),
};
assert.deepEqual(parseStoredPackageExtensionBinding(packageWrapper([skillEntry('skills/a')], singleChildWorkflow)).workflow,
  singleChildWorkflow, 'The private child marker preserves one exact plugin-child selection.');

invalidPackageFixture(packageWrapper([]), 'An empty wrapper cannot omit its package identity.');
invalidPackageFixture(packageWrapper([skillEntry('skills/a')]), 'A complete V1 plugin scope requires its explicit parent selection.');
invalidPackageFixture(packageWrapper([pluginEntry(), pluginEntry(['skills/a'])]), 'A package wrapper has at most one plugin parent, regardless of selection mask.');
invalidPackageFixture(packageWrapper([pluginEntry(), skillEntry('skills/a'), skillEntry('skills/a')]), 'Duplicate exact child identities are rejected.');
invalidPackageFixture(packageWrapper([skillEntry('', 'standalone'), skillEntry('')], rootChildWorkflow), 'Different origin labels cannot alias the same exact skill identity.');
invalidPackageFixture(packageWrapper([pluginEntry(['missing/skill'])]), 'A subset cannot invent a root outside private selectedSkills.');
invalidPackageFixture(packageWrapper([pluginEntry(['skills/a', 'skills/a'])]), 'Subset roots must be unique.');
invalidPackageFixture(packageWrapper([pluginEntry(['../private'])]), 'Subset traversal is rejected.');
invalidPackageFixture(packageWrapper([pluginEntry(), skillEntry('missing/skill')]), 'Individual children must exist in the exact V1 source.');
invalidPackageFixture(packageWrapper([pluginEntry(), skillEntry('', 'standalone')]), 'A child of a selected plugin cannot masquerade as standalone.');
invalidPackageFixture(packageWrapper([pluginEntry()], rootChildWorkflow), 'A plugin entry cannot drop its V1 parent workflow scope.');
invalidPackageFixture(packageWrapper([skillEntry('skills/a')], childWorkflow), 'A child-only wrapper cannot silently retain an unselected V1 child.');
invalidPackageFixture(packageWrapper([skillEntry('skills/a', 'standalone')], singleChildWorkflow), 'A standalone skill cannot use a nonempty child root.');
invalidPackageFixture(changedPackageFixture(packageWrapper([skillEntry('')], rootChildWorkflow), ['workflow', 'childRelativeRoot'], 'skills/a'), 'A child marker cannot contradict an empty root.');
invalidPackageFixture(changedPackageFixture(packageWrapper([skillEntry('skills/a')], singleChildWorkflow), ['workflow', 'childRelativeRoot'], 'skills/b'), 'A child marker must match the exact selected root.');
invalidPackageFixture(changedPackageFixture(packageWrapper([skillEntry('skills/a'), skillEntry('skills/b')], childWorkflow), ['workflow', 'childRelativeRoot'], 'skills/a'), 'A child marker cannot summarize multiple roots.');
invalidPackageFixture(changedPackageFixture(original, ['workflow', 'childRelativeRoot'], 'skills/a'), 'An explicit parent selection cannot become a private child marker.');

for (const [field, replacement] of [
  ['resourceRef', 'canvas-resource:44444444-4444-4444-8444-444444444444'],
  ['publishedRevisionRef', 'canvas-package-revision:44444444-4444-4444-8444-444444444444'],
  ['checksum', 'b'.repeat(64)],
] as const) {
  invalidPackageFixture(changedPackageFixture(original, ['selections', 0, 'selection', 'package', field], replacement),
    'A selection and its private workflow must hold the identical resource, revision and checksum.');
}
invalidPackageFixture(changedPackageFixture(original, ['workflow', 'selectedSkills', 1, 'relativeRoot'], ''), 'Corrupt V1 duplicate roots remain rejected by the original codec.');
invalidPackageFixture(changedPackageFixture(original, ['workflow', 'declarations', 0, 'capabilities', 0, 'selection', 'target', 'accountSelectionRef'], 'cmp_account_private'), 'V1 private targets cannot retain intake account receipts.');
for (const [fields, value] of [
  [['accountSelectionRef'], 'cmp_personal_account_private'],
  [['providerRef'], 'mcp:v1:invented'],
  [['selections', 0, 'accountSelectionRef'], 'cmp_personal_account_private'],
  [['selections', 0, 'selection', 'providerRef'], 'composio:v1:invented'],
  [['selections', 0, 'selection', 'label'], 'Client label'],
  [['workflow', 'credentials'], { apiKey: 'PRIVATE_KEY' }],
] as const) invalidPackageFixture(changedPackageFixture(original, fields, value), 'Unknown wrapper/selection fields, credentials and intake references are rejected.');
invalidPackageFixture(changedPackageFixture(original, ['selections', 0, 'accountSelectionRef'], undefined), 'Undefined receipt fields cannot disappear during copying.');
invalidPackageFixture(changedPackageFixture(original, ['selections', 0, 'toolCap'], ['READ', 'READ']), 'Caps preserve unique exact tool names.');
invalidPackageFixture(changedPackageFixture(original, ['selections', 0, 'requirement'], 'recommended'), 'Only explicit optional and required are accepted.');
invalidPackageFixture(changedPackageFixture(original, ['version'], 1), 'The V2 wrapper cannot masquerade as a legacy V1 workflow.');
invalidPackageFixture(changedPackageFixture(original, ['version'], 3), 'Unknown wrapper versions fail closed.');
invalidPackageFixture(changedPackageFixture(original, ['kind'], 'standalone'), 'A connection discriminator cannot absorb a package wrapper.');
invalidPackageFixture(changedPackageFixture(original, ['workflow'], null), 'A package workflow is required.');
invalidPackageFixture(changedPackageFixture(original, ['workflow', 'version'], 2), 'The wrapper does not rewrite the private V1 codec version.');
invalidPackageFixture(packageWrapper([{ selection: { kind: 'mcp', source: 'mcp', target: {
  kind: 'personal', connectionRef: 'mcp-personal:11111111-1111-4111-8111-111111111111' } }, requirement: 'optional', toolCap: null }]),
'Standalone connections remain separate private connection rows.');

let getterCalls = 0;
const accessor = { ...original };
Object.defineProperty(accessor, 'workflow', { enumerable: true, get() { getterCalls += 1; return original.workflow; } });
invalidPackageFixture(accessor, 'Private parsing rejects accessors without evaluating them.');
assert.equal(getterCalls, 0);
const cyclic: Record<string, unknown> = { ...original };
cyclic.cycle = cyclic;
invalidPackageFixture(cyclic, 'Cyclic input is rejected.');
invalidPackageFixture(new Date(), 'toJSON instances cannot hide invalid stored fields.');
invalidPackageFixture(changedPackageFixture(original, ['selections'], new Array(2)), 'Sparse arrays cannot normalize invalid selections.');
invalidPackageFixture(changedPackageFixture(original, ['padding'], 'x'.repeat(1_048_577)), 'The whole wrapper, including workflow and selections, has one bounded UTF-8 budget.');
invalidPackageFixture(changedPackageFixture(original, ['selections'], Array.from({ length: 257 }, () => pluginEntry())), 'The selection count is bounded.');

assert.equal(JSON.stringify(parentWorkflow), encodedV1, 'Parsing and freezing the V2 copy never modify caller-owned V1 data.');
assert.deepEqual(parseStoredAgentWorkflowPackage(parentWorkflow), parentWorkflow, 'Legacy V1 private data still uses the original untouched codec.');
invalidPackageFixture(parentWorkflow, 'Unwrapped V1 remains a separate dispatch case, not an implicit V2 conversion.');

console.log('PASS V2 private package wrapper: immutable pins, parent/union masks, root/child origins, receipt rejection, bounded frozen copies and unchanged V1.');
