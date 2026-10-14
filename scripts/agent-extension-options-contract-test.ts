import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { agentExtensionOptionsRequestSchema as schema, agentExtensionMetadataOptionsRequestSchema,
  agentExtensionAccountOptionsRequestSchema, type AgentExtensionOptionsResponse } from '../app/lib/agents/extension-options-contracts';
import { agentExtensionConfigurationInputSchema } from '../app/lib/capabilities/extensions/contracts';
import * as publicWorkflow from '../app/lib/agents/workflow-public-contracts';
import * as serverWorkflow from '../app/lib/agents/workflow-contracts';

// Syntax and public scope boundaries only. No runtime handle, account receipt,
// target ACL, connection authorization or provider availability is issued here.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pin = { resourceRef: `canvas-resource:${uuid(1)}`, publishedRevisionRef: `canvas-package-revision:${uuid(2)}`, checksum: 'a'.repeat(64) };
const prospective = { kind: 'prospective', scopeType: 'user' };
const existing = { kind: 'existing', agentId: 'fixture-agent', expectedRevision: 3, expectedWorkflowRevision: 2 };
const ownChoice = { kind: 'user_choice', agentId: 'fixture-agent', capabilityKey: `agent-extension:${'b'.repeat(43)}`,
  expectedWorkflowRevision: 2, expectedPreferenceRevision: 0 };
const empty = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
const packageSelector = { kind: 'package', package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'design', alternativeKey: 'composio:canva' };
let assertions = 0;
const accepts = (value: unknown) => { assertions++; const parsed = schema.safeParse(value); assert(parsed.success, parsed.success ? 'Expected a valid request.' : JSON.stringify(parsed.error.issues)); return parsed.data; };
const rejects = (value: unknown) => { assertions++; assert.equal(schema.safeParse(value).success, false); };

const search = accepts({ operation: 'search', target: prospective });
assert(search.operation === 'search');
assert.deepEqual(search.types, ['plugin', 'skill', 'integration', 'mcp']); assert.equal(search.scope, 'all');
assert.equal(search.stock, 'all'); assert.equal(search.source, 'all'); assert.equal(search.cursor, null);
accepts({ operation: 'search', target: { ...prospective, scopeType: 'organization' }, q: 'Canva brief', types: ['skill', 'plugin'] });
accepts({ operation: 'search', target: existing, scope: 'user', audience: 'shared', selected: 'composio:canva', cursor: 'opaque-query-bound-cursor' });
accepts({ operation: 'search', target: existing, scope: 'team', teamId: 'actual-team' });
for (const patch of [{ types: [] }, { types: ['mcp', 'mcp'] }, { types: ['composio'] }, { q: 'x'.repeat(513) }, { limit: 51 },
  { scope: 'team' }, { teamId: 'wrong-scope' }, { audience: 'own' }, { cursor: ' padded' }, { cursor: 'x'.repeat(8_193) }])
  rejects({ operation: 'search', target: prospective, ...patch });

accepts({ operation: 'package_version', target: existing, ...pin });
accepts({ operation: 'package_version', target: prospective, resourceRef: pin.resourceRef, publishedRevisionRef: pin.publishedRevisionRef });
rejects({ operation: 'package_version', target: prospective, ...pin, publishedRevisionRef: 'latest' });
rejects({ operation: 'package_version', target: prospective, ...pin, checksum: 'A'.repeat(64) });
accepts({ operation: 'connection_choices', target: prospective, selector: packageSelector });
accepts({ operation: 'connection_choices', target: existing, selector: { kind: 'standalone', source: 'composio', toolkit: 'duck_duck_go' }, profileId: 'exact-owned-profile' });
accepts({ operation: 'connection_choices', target: prospective, selector: { kind: 'standalone', source: 'mcp' } });
rejects({ operation: 'connection_choices', target: prospective, selector: { kind: 'standalone', source: 'mcp' }, profileId: 'composio-profile' });
rejects({ operation: 'connection_choices', target: prospective, selector: { ...packageSelector, alternativeKey: 'mcp:reader' }, profileId: 'composio-profile' });
rejects({ operation: 'connection_choices', target: prospective, selector: { ...packageSelector, declarationPath: '../SKILL.md' } });
rejects({ operation: 'connection_choices', target: prospective, selector: { kind: 'standalone', source: 'composio', toolkit: 'Canva / sheets' } });
accepts({ operation: 'connection_choices', target: ownChoice, selector: { kind: 'slot' } });
accepts({ operation: 'connection_choices', target: ownChoice, selector: { kind: 'slot', alternativeKey: 'composio:canva' }, profileId: 'own-profile' });
rejects({ operation: 'connection_choices', target: ownChoice, selector: { kind: 'slot', alternativeKey: 'mcp:reader' }, profileId: 'profile' });
rejects({ operation: 'connection_choices', target: ownChoice, selector: packageSelector });
rejects({ operation: 'connection_choices', target: ownChoice, selector: { kind: 'standalone', source: 'mcp' } });
rejects({ operation: 'connection_choices', target: existing, selector: { kind: 'slot' } });
rejects({ operation: 'search', target: ownChoice });
rejects({ operation: 'package_version', target: ownChoice, ...pin });
rejects({ operation: 'preview', target: ownChoice, configuration: empty });
accepts({ operation: 'connection_choices', target: { ...ownChoice, capabilityKey: `agent-capability:${'c'.repeat(43)}` }, selector: { kind: 'slot' } });
for (const capabilityKey of ['arbitrary-label', `agent-extension:${'b'.repeat(64)}`, `agent-capability:${'c'.repeat(42)}`, 'agent-extension:../private'])
  rejects({ operation: 'connection_choices', target: { ...ownChoice, capabilityKey }, selector: { kind: 'slot' } });
for (const privateField of ['configuration', 'retainedBindingRef', 'actor', 'ownerUserId', 'personalBinding', 'providerRef', 'headers', 'credentials'])
  rejects({ operation: 'connection_choices', target: ownChoice, selector: { kind: 'slot' }, [privateField]: 'private' });
for (const target of [{ ...prospective, agentId: 'fake-agent' }, { ...prospective, scopeType: 'system' },
  { ...existing, expectedRevision: 0 }, { ...existing, expectedWorkflowRevision: undefined },
  { ...ownChoice, expectedPreferenceRevision: undefined }, { ...ownChoice, expectedRevision: 3 }]) rejects({ operation: 'search', target });
rejects({ operation: 'connection_choices', target: { ...ownChoice, expectedPreferenceRevision: undefined }, selector: { kind: 'slot' } });
const explicitAccount = { operation: 'connection_choices', target: existing,
  selector: { kind: 'standalone', source: 'composio', toolkit: 'canva' }, profileId: 'actual-owned-profile' };
assert(agentExtensionAccountOptionsRequestSchema.safeParse(explicitAccount).success);
assert.equal(agentExtensionMetadataOptionsRequestSchema.safeParse(explicitAccount).success, false);
assert.equal(agentExtensionAccountOptionsRequestSchema.safeParse({ ...explicitAccount, profileId: undefined }).success, false);
assert(agentExtensionMetadataOptionsRequestSchema.safeParse({ ...explicitAccount, profileId: undefined }).success);
assert.equal(agentExtensionAccountOptionsRequestSchema.safeParse({ operation: 'search', target: prospective }).success, false);
assert(agentExtensionAccountOptionsRequestSchema.safeParse({ ...explicitAccount, target: ownChoice, selector: { kind: 'slot' } }).success);
assert.equal(agentExtensionMetadataOptionsRequestSchema.safeParse({ ...explicitAccount, target: ownChoice, selector: { kind: 'slot' } }).success, false);

accepts({ operation: 'preview', target: prospective, configuration: empty, enabledTools: null });
accepts({ operation: 'preview', target: existing, configuration: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' }, enabledTools: ['__none__'] });
rejects({ operation: 'preview', target: prospective, configuration: empty, enabledTools: ['read', 'read'] });
rejects({ operation: 'preview', target: prospective, configuration: empty, effectiveExtensions: { fingerprint: 'untrusted' } });
const retained = { ...empty, standalone: [{ mode: 'fixed', configurationId: 'actual-saved-slot', entry: {
  selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${uuid(3)}` } },
  requirement: 'optional', toolCap: null, retainedBindingRef: `agent-extension-retain:v1:${'c'.repeat(64)}` } }] };
accepts({ operation: 'preview', target: existing, configuration: retained });
rejects({ operation: 'preview', target: prospective, configuration: retained });
const retainedPackage = { ...empty, selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } },
  requirement: 'required', toolCap: null }], workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' },
  declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'design', selection: { mode: 'fixed',
    alternativeKey: 'composio:canva', target: { kind: 'retained', retainedBindingRef: `agent-workflow-retain:v1:${'d'.repeat(64)}` }, toolCap: null } }] }] }] } };
accepts({ operation: 'preview', target: existing, configuration: retainedPackage });
rejects({ operation: 'preview', target: prospective, configuration: retainedPackage });
const shared = { ...empty, standalone: [{ mode: 'fixed', entry: { selection: { kind: 'mcp', source: 'mcp',
  target: { kind: 'shared', connectionRef: `canvas-connection:${uuid(4)}`, bindingRevision: 0 } }, requirement: 'optional', toolCap: null } }] };
rejects({ operation: 'preview', target: prospective, configuration: shared });

const tools = Array.from({ length: 230 }, (_, i) => `tool-${i}-${'x'.repeat(245)}`);
const boundedConfiguration = { ...empty, standalone: Array.from({ length: 16 }, (_, i) => ({ mode: 'fixed', entry: {
  selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${uuid(i + 10)}` } },
  requirement: 'optional', toolCap: tools } })) };
assert(agentExtensionConfigurationInputSchema.safeParse(boundedConfiguration).success, 'The nested canonical configuration is independently within its byte bound.');
const combined = { operation: 'preview', target: existing, configuration: boundedConfiguration,
  enabledTools: Array.from({ length: 512 }, (_, i) => `native-${i}-${'y'.repeat(245)}`) };
assert(new TextEncoder().encode(JSON.stringify(combined)).byteLength > 1_048_576);
rejects(combined);
assert.equal(agentExtensionMetadataOptionsRequestSchema.safeParse(combined).success, false);

// Check the actual erased runtime import graph, without a browser or build. This
// catches transitive Node/server imports in otherwise apparently public schemas.
const inspected = new Set<string>(), nodeBuiltins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
function inspectClientImports(filename: string) {
  if (inspected.has(filename)) return;
  inspected.add(filename);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true,
  } }).outputText;
  const source = ts.createSourceFile(filename, output, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text;
      assert(!nodeBuiltins.has(name) && name !== 'server-only', `Client runtime import: ${name} in ${filename}`);
      if (name.startsWith('.') || name.startsWith('@/')) {
        const candidate = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(filename), name);
        inspectClientImports(`${candidate}.ts`);
      } else assert.equal(name, 'zod', 'Public option contracts only need the client-safe schema library.');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
inspectClientImports(path.resolve('app/lib/agents/extension-options-contracts.ts'));
inspectClientImports(path.resolve('app/lib/agents/workflow-api-contracts.ts'));
const advertised = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
assert(Array.isArray(advertised.anyOf) && advertised.anyOf.length === 5, 'The tool advertises the actual five strict operation/target variants.');
type UserChoiceResponse = Extract<AgentExtensionOptionsResponse, { target: { kind: 'user_choice' } }>;
type ConfigurationChoicesResponse = Extract<AgentExtensionOptionsResponse, { operation: 'connection_choices'; target: { kind: 'existing' | 'prospective' } }>;
const ownSelector: UserChoiceResponse['selector'] = { kind: 'slot' };
assert.equal(ownSelector.kind, 'slot');
// @ts-expect-error Use-only responses cannot advertise central configuration selectors.
const forbiddenOwnSelector: UserChoiceResponse['selector'] = { kind: 'standalone', source: 'mcp' };
assert.equal(forbiddenOwnSelector.kind, 'standalone');
// @ts-expect-error Central configuration responses cannot pretend to be a Use-only slot.
const forbiddenConfigurationSelector: ConfigurationChoicesResponse['selector'] = { kind: 'slot' };
assert.equal(forbiddenConfigurationSelector.kind, 'slot');

// Existing importers keep the same schema and error objects. Private stored
// codecs and capability IDs remain server-side consumers of those schemas.
assert.equal(serverWorkflow.AgentWorkflowError, publicWorkflow.AgentWorkflowError);
assert.equal(serverWorkflow.agentWorkflowConfigurationSchema, publicWorkflow.agentWorkflowConfigurationSchema);
assert.equal(serverWorkflow.agentWorkflowPackageSchema, publicWorkflow.agentWorkflowPackageSchema);
assert.equal(serverWorkflow.agentWorkflowTargetSchema, publicWorkflow.agentWorkflowTargetSchema);
assert.equal(serverWorkflow.AGENT_WORKFLOW_LIMITS, publicWorkflow.AGENT_WORKFLOW_LIMITS);
assert.equal(serverWorkflow.parseAgentWorkflowConfiguration, publicWorkflow.parseAgentWorkflowConfiguration);
const workflow = { version: 1, packages: [{ ...pin, skillSelection: { kind: 'skills', relativeRoots: [''] }, declarations: [] }] };
assert.deepEqual(publicWorkflow.parseAgentWorkflowConfiguration(workflow), workflow);
assert.throws(() => publicWorkflow.parseAgentWorkflowConfiguration({ version: 1, packages: [...workflow.packages, ...workflow.packages] }),
  error => error instanceof serverWorkflow.AgentWorkflowError && serverWorkflow.isAgentWorkflowError(error) && error.code === 'AGENT_WORKFLOW_INVALID');
assert.throws(() => publicWorkflow.parseAgentWorkflowConfiguration({ text: '😀'.repeat(270_000) }),
  error => error instanceof serverWorkflow.AgentWorkflowError && error.message === 'The workflow configuration exceeds its limits.');
const target = { kind: 'shared', source: 'composio', connectionRef: `canvas-connection:${uuid(4)}`, bindingRevision: 3 };
assert.deepEqual(serverWorkflow.parseStoredAgentWorkflowTarget(target), target);
assert.throws(() => serverWorkflow.parseStoredAgentWorkflowTarget({ ...target, credentials: 'forbidden' }), serverWorkflow.AgentWorkflowError);
const storedPackage = { ...pin, version: 1, skillSelection: { kind: 'plugin' }, selectedSkills: [{ name: 'root-fixture', relativeRoot: '' }],
  declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'design', required: true, application: 'Design',
    alternatives: [{ source: 'composio', toolkit: 'canva' }], selection: { mode: 'fixed', alternativeKey: 'composio:canva', target, toolCap: null } }] }] };
assert.deepEqual(serverWorkflow.parseStoredAgentWorkflowPackage(storedPackage), storedPackage);
assert.equal(serverWorkflow.agentWorkflowCapabilityKey(pin.resourceRef, '.canvas-plugin/plugin.json', 'design'),
  'agent-capability:ksTFC3MniJQ-L_9GK-djINZvb8znO-1R8zUib0s1nZ8');

// Actually bundle the public entry for the browser platform. Evaluate without
// Buffer, process, require or server globals; this is no browser/UI E2E claim.
const bundled = buildSync({ stdin: { contents: `
  export { agentExtensionOptionsRequestSchema } from './app/lib/agents/extension-options-contracts';
  export { parseAgentWorkflowConfiguration } from './app/lib/agents/workflow-public-contracts';
  export { createCompleteAgentConfigurationSchema, updateCompleteAgentConfigurationSchema } from './app/lib/agents/workflow-api-contracts';
`, resolveDir: process.cwd(), sourcefile: 'agent-options-browser-contract-fixture.ts', loader: 'ts' },
  bundle: true, platform: 'browser', format: 'iife', globalName: 'CanvasAgentOptionsContract', write: false, metafile: true, logLevel: 'silent' });
assert(bundled.outputFiles);
assert.equal(bundled.outputFiles.length, 1);
assert(Object.keys(bundled.metafile!.inputs).every(name => !name.endsWith('/agents/workflow-contracts.ts') && !name.includes('stored-')));
const sandbox: { TextEncoder: typeof TextEncoder; CanvasAgentOptionsContract?: { agentExtensionOptionsRequestSchema: typeof schema;
  parseAgentWorkflowConfiguration: typeof publicWorkflow.parseAgentWorkflowConfiguration;
  createCompleteAgentConfigurationSchema: typeof import('../app/lib/agents/workflow-api-contracts').createCompleteAgentConfigurationSchema;
  updateCompleteAgentConfigurationSchema: typeof import('../app/lib/agents/workflow-api-contracts').updateCompleteAgentConfigurationSchema } } = { TextEncoder };
runInNewContext(bundled.outputFiles[0]!.text, sandbox, { timeout: 5_000 });
assert(sandbox.CanvasAgentOptionsContract);
assert(sandbox.CanvasAgentOptionsContract.agentExtensionOptionsRequestSchema.safeParse({ operation: 'search', target: prospective }).success);
assert.equal(sandbox.CanvasAgentOptionsContract.agentExtensionOptionsRequestSchema.safeParse({ operation: 'search', target: ownChoice }).success, false);
assert.equal(JSON.stringify(sandbox.CanvasAgentOptionsContract.parseAgentWorkflowConfiguration(workflow)), JSON.stringify(workflow));
assert.throws(() => sandbox.CanvasAgentOptionsContract!.parseAgentWorkflowConfiguration({ text: '😀'.repeat(270_000) }),
  error => publicWorkflow.isAgentWorkflowError(error) && error.code === 'AGENT_WORKFLOW_INVALID');
const browserCreate = sandbox.CanvasAgentOptionsContract.createCompleteAgentConfigurationSchema;
assert(browserCreate.safeParse({ name: 'Canonical form', extensions: empty }).success);
assert.equal(browserCreate.safeParse({ name: 'Missing complete selection' }).success, false);
for (const field of ['workflow', 'capabilities', 'relevantSkills', 'relevantConnections'])
  assert.equal(browserCreate.safeParse({ name: 'Legacy input', extensions: empty, [field]: [] }).success, false);
const browserUpdate = sandbox.CanvasAgentOptionsContract.updateCompleteAgentConfigurationSchema;
const profileOnly = browserUpdate.parse({ agentId: 'actual-agent', expectedRevision: 3, name: 'Only profile changes' });
assert.equal(Object.hasOwn(profileOnly, 'extensions'), false, 'A profile-only browser form cannot silently replace its extension selection.');
assert.equal(browserUpdate.safeParse({ ...profileOnly, extensions: empty }).success, false);
assert(browserUpdate.safeParse({ ...profileOnly, extensions: empty, expectedWorkflowRevision: 2 }).success);
console.log(`PASS ${assertions} agent options contract cases: exact target scopes, Use-only slot boundary, all four search types, explicit chooser, current revisions, full byte bound, canonical shared schemas/private codec compatibility, ${inspected.size} client-safe runtime modules and actual browser-platform bundle execution; syntax is not authority.`);
