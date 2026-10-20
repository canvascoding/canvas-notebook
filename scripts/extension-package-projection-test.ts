import assert from 'node:assert/strict';
import type { StoredAgentWorkflowPackage } from '../app/lib/agents/workflow-contracts';
import type { ExtensionSelectionEntry } from '../app/lib/capabilities/extensions/contracts';
import { applyPackageExtensionTurnFocus, intersectPackageExtensionToolCaps, projectPackageExtensionSelection } from '../app/lib/capabilities/packages/extension-projection';

const pin = { resourceRef: 'canvas-resource:11111111-1111-1111-1111-111111111111',
  publishedRevisionRef: 'canvas-package-revision:22222222-2222-2222-2222-222222222222', checksum: 'a'.repeat(64) };
const inventory = [{ name: 'root-skill', relativeRoot: '' }, { name: 'brief', relativeRoot: 'skills/brief' }, { name: 'export', relativeRoot: 'skills/export' }];
const source: StoredAgentWorkflowPackage = { ...pin, version: 1, skillSelection: { kind: 'plugin' }, selectedSkills: inventory.map(skill => ({ ...skill })),
  declarations: ['.canvas-plugin/plugin.json', 'agents/canvas.yaml', 'skills/brief/agents/canvas.yaml', 'skills/export/agents/canvas.yaml'].map((declarationPath, index) => ({
    declarationPath, capabilities: [{ capabilityId: `cap-${index}`, application: 'canva', required: index === 0,
      alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['READ'] }],
      selection: index === 2 ? { mode: 'selectable', allowedChoices: [{ choiceId: 'one', alternativeKey: 'composio:canva', toolCap: ['READ', 'WRITE'],
        target: { kind: 'shared', source: 'composio', connectionRef: 'canvas-connection:33333333-3333-3333-3333-333333333333', bindingRevision: 1 } }],
        personalPolicy: { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: ['READ', 'WRITE'] }, defaultChoiceId: 'one' }
        : { mode: 'fixed', alternativeKey: 'composio:canva', toolCap: ['READ', 'WRITE'],
          target: { kind: 'shared', source: 'composio', connectionRef: 'canvas-connection:33333333-3333-3333-3333-333333333333', bindingRevision: 1 } } }] })) };
const parent = (roots: string[] | 'all', toolCap: string[] | null = null): ExtensionSelectionEntry => ({ requirement: 'required', toolCap,
  selection: { kind: 'plugin', package: pin, skillSelection: roots === 'all' ? { kind: 'all' } : { kind: 'subset', relativeRoots: roots } } });
const child = (relativeRoot: string, toolCap: string[] | null = null): ExtensionSelectionEntry => ({ requirement: 'optional', toolCap,
  selection: { kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot } });
const project = (selections?: ExtensionSelectionEntry[], requiredRoots?: string[]) => projectPackageExtensionSelection({ source, kind: 'plugin', inventory, selections, requiredRoots });
const original = JSON.stringify(source);

assert.equal(project().configuration, source, 'V1 is returned unchanged, including child-only declaration semantics.');
assert.deepEqual(project([parent('all')]).selectedRoots, ['', 'skills/brief', 'skills/export']);
const empty = project([parent([])]).configuration;
assert.deepEqual(empty.selectedSkills, []);
assert.deepEqual(empty.declarations.map(value => value.declarationPath), ['.canvas-plugin/plugin.json']);
assert.equal(empty.declarations[0].capabilities[0].required, true, 'An empty child mask retains the mandatory parent capability.');
const union = project([parent(['skills/brief']), child('', ['READ']), child('skills/export')]).configuration;
assert.deepEqual(union.selectedSkills, inventory);
assert.deepEqual(project([parent([])], ['skills/export']).selectedRoots, ['skills/export'], 'A current policy-required held child survives its optional mask.');
const capped = project([parent(['skills/brief'], ['READ', 'OTHER']), child('skills/brief', ['READ', 'WRITE'])]).configuration;
assert.equal(capped.declarations.length, 2);
const parentSelection = capped.declarations[0].capabilities[0].selection;
assert(parentSelection.mode === 'fixed'); assert.deepEqual(parentSelection.toolCap, ['READ']);
const childSelection = capped.declarations[1].capabilities[0].selection;
assert(childSelection.mode === 'selectable'); assert.deepEqual(childSelection.allowedChoices[0].toolCap, ['READ']);
assert.deepEqual(childSelection.personalPolicy?.toolCap, ['READ'], 'A per-user choice cannot widen the parent/child ceiling.');
const noCalls = project([parent(['skills/brief'], [])]).configuration;
// Fixed and selectable modes keep their different wire shapes.
const noCallFixed = noCalls.declarations[0].capabilities[0].selection;
assert(noCallFixed.mode === 'fixed'); assert.deepEqual(noCallFixed.toolCap, []);
assert.deepEqual(noCallFixed.alternativeKey, 'composio:canva');
assert.deepEqual(noCalls.declarations[0].capabilities[0].alternatives[0].requiredTools, ['READ'], 'Missing mandatory tools remain a readiness failure; the cap is never widened.');
assert.deepEqual(intersectPackageExtensionToolCaps(null, ['READ', 'WRITE'], ['WRITE', 'OTHER']), ['WRITE']);
assert.deepEqual(intersectPackageExtensionToolCaps([], null, ['READ']), []);
assert.equal(intersectPackageExtensionToolCaps(null, null), null);
const focus = applyPackageExtensionTurnFocus(capped, 'plugin', [child('skills/brief', [])]);
assert.deepEqual(focus.selectedSkills, capped.selectedSkills, 'A turn changes focus/caps, not the fixed configured availability.');
const focusedChoice = focus.declarations[1].capabilities[0].selection;
assert(focusedChoice.mode === 'selectable'); assert.deepEqual(focusedChoice.allowedChoices[0].toolCap, []);
assert.throws(() => applyPackageExtensionTurnFocus(capped, 'plugin', [child('skills/export')]), /cannot add/);
assert.throws(() => applyPackageExtensionTurnFocus(capped, 'plugin', [{ ...parent('all'), selection: { ...parent('all').selection,
  package: { ...pin, publishedRevisionRef: 'canvas-package-revision:44444444-4444-4444-4444-444444444444' } } } as ExtensionSelectionEntry]), /cannot switch/);
assert.throws(() => project([parent(['skills/missing'])]), /actual child/);
assert.throws(() => project([parent([]), { ...child(''), selection: { kind: 'skill', package: pin, origin: 'standalone', relativeRoot: '' } }]), /origin/);
assert.throws(() => project([child('skills/brief')]), /parent declaration/);
assert.throws(() => project([parent([])], ['unknown']), /required skill/);
assert.equal(JSON.stringify(source), original, 'Projection never mutates the durable V1 source, targets, caps or declaration arrays.');

const childOnly: StoredAgentWorkflowPackage = { ...source, skillSelection: { kind: 'skills', relativeRoots: ['skills/brief'] },
  selectedSkills: [inventory[1]!], declarations: [source.declarations[2]!] };
const childResult = projectPackageExtensionSelection({ source: childOnly, kind: 'plugin', inventory, selections: [child('skills/brief', ['WRITE'])] }).configuration;
assert.deepEqual(childResult.declarations.map(value => value.declarationPath), ['skills/brief/agents/canvas.yaml']);
assert.throws(() => applyPackageExtensionTurnFocus(childOnly, 'plugin', [parent('all')]), /expand a child-only/);
const standalone: StoredAgentWorkflowPackage = { ...source, skillSelection: { kind: 'skills', relativeRoots: [''] },
  selectedSkills: [inventory[0]!], declarations: [source.declarations[1]!] };
const standaloneEntry: ExtensionSelectionEntry = { ...child('', []), selection: { kind: 'skill', package: pin, origin: 'standalone', relativeRoot: '' } };
const standaloneResult = projectPackageExtensionSelection({ source: standalone, kind: 'skill', inventory: [inventory[0]!], selections: [standaloneEntry] });
assert.deepEqual(standaloneResult.selectedRoots, ['']);
const standaloneCap = standaloneResult.configuration.declarations[0].capabilities[0].selection;
assert(standaloneCap.mode === 'fixed'); assert.deepEqual(standaloneCap.toolCap, []);
assert.throws(() => projectPackageExtensionSelection({ source: standalone, kind: 'skill', inventory: [inventory[0]!], selections: [child('')] }), /origin/);
console.log('PASS package extension projections: V1 identity, actual child/root origins, parent obligations, union/required masks, fixed and selectable cap intersections, focus fences and immutable source.');
