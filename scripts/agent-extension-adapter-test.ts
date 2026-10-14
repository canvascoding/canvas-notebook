import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { Type } from 'typebox';
import * as schemas from '../app/lib/agents/workflow-api-contracts';
import * as managementSchemas from '../app/lib/agents/workflow-management-contracts';
import type { AgentTool } from '@earendil-works/pi-agent-core';

// Actual shared schemas and current route/tool source, with controlled auth and
// writer boundaries. This verifies strict intake/parity; native writer fixtures
// separately establish SQL/ACL, atomic publication and persisted source authority.
const require = createRequire(import.meta.url);
const fixed = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] } as const;
const inherit = { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } as const;
const sharedRef = 'canvas-connection:11111111-1111-4111-8111-111111111111';
const packagePin = { resourceRef: 'canvas-resource:22222222-2222-4222-8222-222222222222',
  publishedRevisionRef: 'canvas-package-revision:33333333-3333-4333-8333-333333333333', checksum: 'a'.repeat(64) };
const pluginSelection = { selection: { kind: 'plugin', package: packagePin, skillSelection: { kind: 'subset', relativeRoots: [] } }, requirement: 'optional', toolCap: [] };
const skillSelection = { selection: { kind: 'skill', package: packagePin, origin: 'plugin_child', relativeRoot: 'skills/brief' }, requirement: 'optional', toolCap: null };
const configuration = { ...fixed, selections: [pluginSelection, skillSelection], workflow: { version: 1, packages: [{ ...packagePin,
  skillSelection: { kind: 'plugin' }, declarations: [] }] }, standalone: [
  { mode: 'fixed', entry: { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: sharedRef, bindingRevision: 3 } },
    requirement: 'optional', toolCap: [] } },
  { mode: 'selectable', configurationId: 'canva-slot', source: 'composio', toolkit: 'canva', requirement: 'optional',
    allowedChoices: [{ choiceId: 'team-canva', selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
      target: { kind: 'shared', connectionRef: 'canvas-connection:44444444-4444-4444-8444-444444444444', bindingRevision: 5 } }, toolCap: ['READ'] }],
    defaultChoiceId: 'team-canva' },
] };

function loadCurrentSource(file: string, mocks: Record<string, unknown>): unknown {
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('@/')) throw new Error(`Unexpected adapter dependency ${name}`);
    return require(name);
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

async function main() {
  const create = { name: 'Exact Agent', extensions: configuration };
  assert.deepEqual(schemas.createAgentConfigurationSchema.parse(create), create);
  for (const extensions of [fixed, inherit]) assert.deepEqual(schemas.createAgentConfigurationSchema.parse({ name: 'Mode', extensions }).extensions, extensions);
  for (const extensions of [fixed, inherit]) assert.equal(schemas.updateAgentConfigurationSchema.safeParse({
    agentId: 'exact-agent', expectedRevision: 2, extensions }).success, false,
  'Fixed and explicit inheritance updates both need the current workflow revision.');
  assert.equal(Object.hasOwn(schemas.updateAgentConfigurationSchema.parse({ agentId: 'exact-agent', expectedRevision: 2, name: 'Rename' }), 'extensions'), false);
  for (const field of ['workflow', 'capabilities', 'relevantSkills', 'relevantConnections']) {
    const legacy = { [field]: field === 'workflow' ? null : [] };
    assert.equal(schemas.updateAgentConfigurationSchema.safeParse({ agentId: 'exact-agent', expectedRevision: 2, extensions: fixed, ...legacy }).success, false);
    assert.equal(schemas.createAgentConfigurationSchema.safeParse({ ...create, ...legacy }).success, false);
  }
  for (const invalid of [{ actor: { userId: 'other' } }, { ownerUserId: 'other' }, { extensions: null }, { files: { 'secrets.env': 'private' } }])
    assert.equal(schemas.createAgentConfigurationSchema.safeParse({ ...create, ...invalid }).success, false);
  const personalAccount = { ...fixed, standalone: [{ mode: 'fixed', entry: { selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
    target: { kind: 'personal', profileId: 'profile', accountBinding: 'account', accountId: 'account', connectionRef: 'composio-personal:profile:account' } },
    requirement: 'optional', toolCap: null } }] };
  assert.equal(schemas.createAgentConfigurationSchema.safeParse({ name: 'Missing exact receipt', extensions: personalAccount }).success, false);
  const standaloneChoice = { agentId: 'exact-agent', capabilityKey: 'agent-extension:' + 'a'.repeat(64),
    expectedWorkflowRevision: 2, expectedPreferenceRevision: 0, standaloneSelection: {
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: sharedRef, bindingRevision: 3 } },
      requirement: 'optional', toolCap: ['READ'] } };
  assert.deepEqual(schemas.bindOwnAgentWorkflowChoiceInput(schemas.updateAgentWorkflowChoiceSchema.parse(standaloneChoice), 'alice'), standaloneChoice);
  assert.equal(schemas.updateAgentWorkflowChoiceSchema.safeParse({ ...standaloneChoice, choiceId: null }).success, false);
  const { standaloneSelection: standaloneSelectionForExclusivity, ...choiceBase } = standaloneChoice;
  const packagePersonalChoice = { alternativeKey: 'mcp:reader', target: { kind: 'personal', source: 'mcp', providerRef: 'personal-source' } };
  assert.equal(schemas.updateAgentWorkflowChoiceSchema.safeParse(choiceBase).success, false);
  assert.equal(schemas.updateAgentWorkflowChoiceSchema.safeParse({ ...choiceBase, choiceId: null }).success, true);
  assert.equal(schemas.updateAgentWorkflowChoiceSchema.safeParse({ ...choiceBase, personalSelection: packagePersonalChoice }).success, true);
  assert.equal(schemas.updateAgentWorkflowChoiceSchema.safeParse({ ...choiceBase, personalSelection: packagePersonalChoice, choiceId: null }).success, false);
  assert.equal(schemas.updateAgentWorkflowChoiceSchema.safeParse({ ...choiceBase, personalSelection: packagePersonalChoice,
    standaloneSelection: standaloneSelectionForExclusivity }).success, false);
  assert.equal(schemas.updateAgentWorkflowChoiceSchema.safeParse({ ...standaloneChoice,
    standaloneSelection: personalAccount.standalone[0].entry }).success, false);

  type Call = { actor: unknown; input: Record<string, unknown> };
  const creates: Call[] = [], updates: Array<Record<string, unknown>> = [], inspections: Array<Record<string, unknown>> = [], choices: Array<Record<string, unknown>> = [];
  const editAccess = { canUse: false, canEdit: true, canManage: false };
  const saved = { agent: { agentId: 'exact-agent', name: 'Exact Agent', scopeType: 'user', revision: 2 },
    extensions: configuration, workflow: { agentId: 'exact-agent', workflowRevision: 2, access: editAccess } };
  class PublicError extends Error { constructor(readonly code: string, message: string, readonly status = 400, readonly details?: unknown) { super(message); } }
  const management = { AgentManagementError: PublicError,
    managementErrorDetails: (error: unknown) => ({ status: Number(Reflect.get(error as object, 'status')) || 400,
      code: Reflect.get(error as object, 'code') || 'AGENT_CONFIGURATION_INVALID', message: (error as Error).message }),
    createManagedAgent: async (actor: unknown, input: Record<string, unknown>) => { creates.push({ actor, input }); return saved; },
    inspectManagedAgent: async (_actor: unknown, _id: string, options: Record<string, unknown> = {}) => {
      inspections.push(options);
      if (options.purpose !== 'configure') throw new PublicError('AGENT_FORBIDDEN', 'Use permission denied.', 403);
      return { ...saved, access: editAccess };
    },
  };
  const workflow = { updateManagedAgentConfiguration: async (input: Record<string, unknown>) => { updates.push(input); return saved; },
    setManagedAgentWorkflowChoice: async (input: Record<string, unknown>) => { choices.push(input); return { agentId: 'exact-agent' }; } };
  const common = { 'server-only': {}, '@/app/lib/agents/management-actions': management,
    '@/app/lib/agents/workflow-configuration': workflow, '@/app/lib/agents/workflow-api-contracts': schemas };
  const toolModule = loadCurrentSource('app/lib/pi/agent-management-tools.ts', { ...common, typebox: { Type }, zod: { z },
    '@/app/lib/agents/workflow-management-contracts': managementSchemas, '@/app/lib/agents/workflow-management': {},
    '@/app/lib/agents/storage': { DEFAULT_MANAGED_AGENT_ID: 'bradley' },
    '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => ({ userId: 'alice', sessionId: 'actual-chat', agentId: 'bradley', workspaceId: 'workspace' }) },
  }) as { createAgentManagementTools: (userId: string, agentId: string, sessionId: string) => AgentTool[] };
  const tools = toolModule.createAgentManagementTools('alice', 'bradley', 'fallback-chat');
  const createTool = tools.find(tool => tool.name === 'create_agent')!, updateTool = tools.find(tool => tool.name === 'update_agent_configuration')!;
  const advertised = JSON.parse(JSON.stringify(createTool.parameters)) as { properties: Record<string, unknown>; additionalProperties: boolean };
  assert.equal(advertised.additionalProperties, false);
  assert(advertised.properties.extensions, 'The actual tool advertises the complete shared extension schema.');
  await createTool.execute('create', create as never);
  assert.deepEqual(creates[0].input, create);
  assert.deepEqual(creates[0].actor, { userId: 'alice', sessionId: 'actual-chat', source: 'tool', sourceAgentId: 'bradley',
    organizationId: undefined, workspaceId: 'workspace', projectId: undefined });
  const patch = { agentId: 'exact-agent', expectedRevision: 2, expectedWorkflowRevision: 2, extensions: configuration };
  await updateTool.execute('update', patch as never);
  assert.deepEqual(updates[0].extensions, configuration);
  const beforeInvalidTool = creates.length;
  await assert.rejects(createTool.execute('invalid', { ...create, userId: 'other' } as never));
  assert.equal(creates.length, beforeInvalidTool);
  const inspectTool = tools.find(tool => tool.name === 'inspect_agent')!;
  const inspectionSchema = JSON.parse(JSON.stringify(inspectTool.parameters)) as {
    additionalProperties: boolean; properties: { purpose: { anyOf: Array<{ const: string }> } } };
  assert.equal(inspectionSchema.additionalProperties, false);
  assert.deepEqual(inspectionSchema.properties.purpose.anyOf.map(value => value.const), ['use', 'configure']);
  await inspectTool.execute('inspect-edit-only', { agentId: 'exact-agent', purpose: 'configure' } as never);
  assert.equal(inspections.at(-1)?.purpose, 'configure');
  await tools.find(tool => tool.name === 'set_agent_workflow_choice')!.execute('standalone-choice', standaloneChoice as never);
  assert.deepEqual(choices[0].standaloneSelection, standaloneChoice.standaloneSelection);

  let authorized = true;
  const route = loadCurrentSource('app/api/agents/route.ts', { ...common,
    '@/app/lib/auth': { auth: { api: { getSession: async () => authorized ? { user: { id: 'alice' }, session: { id: 'auth-session' } } : null } } },
    '@/app/lib/agents/workflow-contracts': { AgentWorkflowError: PublicError },
    '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/app/lib/workspaces/request': { requireSessionWorkspace: async () => ({ workspace: { workspaceId: 'workspace', organizationId: 'organization', projectId: null } }) },
  }) as { GET: (request: NextRequest) => Promise<Response>; POST: (request: NextRequest) => Promise<Response>; PATCH: (request: NextRequest) => Promise<Response> };
  const request = (method: string, body: unknown) => new NextRequest('http://localhost:3000/api/agents?workspaceId=workspace', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await route.POST(request('POST', create))).status, 200);
  assert.deepEqual(creates.at(-1)?.input, create, 'HTTP and tool pass the same canonical parsed input to one writer.');
  const priorInspections = inspections.length;
  const patched = await route.PATCH(request('PATCH', patch));
  assert.equal(patched.status, 200);
  const patchedData = await patched.json();
  assert.deepEqual(patchedData.data.agent.access, editAccess);
  assert.deepEqual(patchedData.data.extensions, configuration);
  assert.equal(inspections.length, priorInspections, 'Successful writes never perform a second Use-only inspection.');
  assert.deepEqual(updates.at(-1)?.extensions, configuration);
  assert.equal((await route.GET(new NextRequest('http://localhost:3000/api/agents?workspaceId=workspace&agentId=exact-agent&purpose=configure'))).status, 200);
  assert.equal(inspections.at(-1)?.purpose, 'configure');
  assert.equal((await route.GET(new NextRequest('http://localhost:3000/api/agents?workspaceId=workspace&agentId=exact-agent'))).status, 403);
  const priorWrites = creates.length + updates.length;
  assert.equal((await route.POST(request('POST', { ...create, ownerUserId: 'other' }))).status, 400);
  assert.equal((await route.PATCH(request('PATCH', { ...patch, relevantConnections: [] }))).status, 400);
  assert.equal((await route.PATCH(request('PATCH', { agentId: 'exact-agent', expectedRevision: 2 }))).status, 400);
  assert.equal(creates.length + updates.length, priorWrites);
  authorized = false;
  assert.equal((await route.POST(request('POST', create))).status, 401);
  assert.equal(creates.length + updates.length, priorWrites);
  console.log('PASS shared agent extension adapters: actual strict schemas, advertised tool/API parity, four types, fixed/inherit/omission, mixed-input rejection and controlled writer/auth boundaries.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
