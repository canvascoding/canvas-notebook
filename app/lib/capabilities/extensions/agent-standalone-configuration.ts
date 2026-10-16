import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { getAgentAccessOnConnection } from '@/app/lib/agents/access';
import { isManagedAgentWorkflowSnapshot } from '@/app/lib/agents/workflow-configuration';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot } from '@/app/lib/agents/workflow-contracts';
import { readAgentProfileOnConnection, type AgentProfile } from '@/app/lib/agents/registry';
import { openDb, type SqlConnection } from '@/app/lib/db';
import {
  authorizeIntegrationConnectionBindingsOnConnection,
  type IntegrationConnectionBindingBatch,
  type IntegrationConnectionBindingAuthorization,
  type HeldEmailV2BindingConfiguration,
} from '@/app/lib/integration-tools/connections/store';
import {
  verifyStoredPersonalWorkflowProviderTarget,
  revalidatePreparedPersonalWorkflowProviderTarget,
  type PreparedPersonalWorkflowProviderTarget,
} from '@/app/lib/integration-tools/workflow-personal-bindings';
import {
  agentStandaloneConfigurationInputSchema,
  EXTENSION_SELECTION_LIMITS,
  extensionSelectionIdentity,
  type AgentStandaloneConfigurationInput,
  type AgentStandaloneEntryInput,
} from './contracts';
import { createStandaloneExtensionSlotRef } from './standalone-reference';
import {
  prepareStandaloneExtensionSelection,
  getPreparedStandaloneExtensionBinding,
  revalidatePreparedStandaloneExtensionSelection,
  type PreparedStandaloneExtensionSelection,
} from './standalone-preparation';
import { copyBoundedJson, freeze, parseStoredStandaloneExtensionBinding, type StoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionTarget } from './stored-contracts';

export type PreparedAgentStandaloneConfigurations = Readonly<{ kind: 'prepared_agent_standalone_configurations'; count: number }>;
type DefinitionStamp = { organizationId: string; id: string; revision: number; fingerprint: string };
type Record = { actorKey: string; verifiedActorKey: string; configurations: readonly StoredStandaloneExtensionBinding[];
  initialPersonal: PreparedStandaloneExtensionSelection[]; retainedPersonal: PreparedPersonalWorkflowProviderTarget[];
  definitions: DefinitionStamp[]; before?: { agentId: string; revision: number; workflowRevision: number }; expiresAt: number };
const host = globalThis as typeof globalThis & { __canvasAgentStandaloneConfigurationsV1?: WeakMap<object, Record> };
const records = host.__canvasAgentStandaloneConfigurationsV1 ??= new WeakMap<object, Record>();
const slotsSchema = z.array(agentStandaloneConfigurationInputSchema).max(EXTENSION_SELECTION_LIMITS.agent);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function denied(code = 'AGENT_EXTENSION_CONFIGURATION_DENIED', message = 'The exact agent extension configuration cannot be verified.'): never {
  throw new AgentWorkflowError(code, message, 403);
}
function actorKey(actor: AgentManagementActor): string {
  return JSON.stringify([actor.userId, actor.organizationId ?? null, actor.workspaceId ?? null, actor.projectId ?? null,
    actor.sourceAgentId ?? null, actor.sessionId ?? null]);
}
async function verifiedActor(actor: AgentManagementActor, database?: SqlConnection): Promise<AgentManagementActor> {
  const connection = database ?? await openDb();
  try {
    const current = await resolveVerifiedAgentActorContextOnConnection(actor, connection, { lock: Boolean(database) });
    return freeze({ ...actor, userId: current.userId, organizationId: current.organizationId,
      workspaceId: current.context.workspaceId ?? null, projectId: current.context.projectId ?? null });
  } finally { if (!database) await connection.close(); }
}
function recordFor(handle: PreparedAgentStandaloneConfigurations, actor: AgentManagementActor): Record {
  const record = handle && typeof handle === 'object' ? records.get(handle) : undefined;
  if (!record || record.actorKey !== actorKey(actor) || record.expiresAt <= Date.now()) return denied();
  return record;
}
function storedSlots(before: AgentWorkflowInternalSnapshot): StoredStandaloneExtensionBinding[] {
  if (!isManagedAgentWorkflowSnapshot(before) || !before.access.canEdit) return denied();
  if (before.workflowVersion !== 2) return [];
  return before.bindings.filter(binding => binding.resourceType === 'connection').map(binding => {
    if (!binding.standaloneConfiguration) return denied();
    const config = parseStoredStandaloneExtensionBinding(binding.standaloneConfiguration);
    const source = config.mode === 'fixed' ? config.entry.selection.source : config.source;
    const toolkit = config.mode === 'fixed' ? config.entry.selection.kind === 'composio' ? config.entry.selection.toolkit : undefined : config.toolkit;
    if (binding.resourceId !== createStandaloneExtensionSlotRef({ configurationId: config.configurationId, source,
      ...(toolkit === undefined ? {} : { toolkit }) })) return denied();
    return config;
  });
}
function retentionRef(actor: AgentManagementActor, before: AgentWorkflowInternalSnapshot,
  configuration: StoredStandaloneExtensionBinding, choiceId?: string): string {
  return `agent-extension-retain:v1:${hash([actor.userId, actor.organizationId ?? null, actor.workspaceId ?? null,
    actor.projectId ?? null, before.agent.agentId, before.agent.revision, before.workflowRevision,
    configuration.configurationId, choiceId ?? null, configuration])}`;
}
function retainedTarget(actor: AgentManagementActor, before: AgentWorkflowInternalSnapshot | undefined,
  configurationId: string | undefined, choiceId: string | undefined, entry: AgentStandaloneEntryInput): StoredStandaloneExtensionTarget {
  if (!before || !configurationId || !entry.retainedBindingRef) return denied('AGENT_EXTENSION_RETENTION_INVALID');
  const matches = storedSlots(before).filter(config => config.configurationId === configurationId);
  if (matches.length !== 1) return denied('AGENT_EXTENSION_RETENTION_INVALID');
  const config = matches[0];
  const previous = config.mode === 'fixed' ? choiceId === undefined ? config.entry : undefined
    : config.allowedChoices.find(choice => choice.choiceId === choiceId);
  const expected = retentionRef(actor, before, config, choiceId);
  if (!previous || entry.retainedBindingRef.length !== expected.length
    || !timingSafeEqual(Buffer.from(entry.retainedBindingRef), Buffer.from(expected))
    || JSON.stringify(previous.selection) !== JSON.stringify(entry.selection)
    || previous.target.kind === 'personal' && previous.target.ownerUserId !== actor.userId) {
    return denied('AGENT_EXTENSION_RETENTION_INVALID', 'The stored connection changed. Reload it or choose an account explicitly.');
  }
  return previous.target;
}
async function definitionStamps(actor: AgentManagementActor, ids: readonly string[]): Promise<DefinitionStamp[]> {
  if (!ids.length) return [];
  if (!actor.organizationId) return denied('AGENT_EXTENSION_POLICY_DENIED');
  const definitions = await (await import('@/app/lib/mcp/server-definitions')).listMcpServerDefinitions(actor.organizationId);
  return ids.map(id => {
    const definition = definitions.find(value => value.id === id);
    if (!definition?.enabled) return denied('AGENT_EXTENSION_POLICY_DENIED', 'An approved MCP definition is unavailable.');
    return { organizationId: actor.organizationId!, id, revision: definition.revision, fingerprint: hash(definition) };
  });
}
async function revalidateDefinitions(record: Record, actor: AgentManagementActor): Promise<void> {
  if (!record.definitions.length) return;
  const current = await definitionStamps(actor, record.definitions.map(definition => definition.id));
  if (JSON.stringify(current) !== JSON.stringify(record.definitions)) return denied('AGENT_EXTENSION_POLICY_CHANGED');
}

/** No shared runtime Use check occurs here: the actual target agent is authorized under the writer's locks. */
export async function prepareAgentStandaloneConfigurations(actorInput: AgentManagementActor, value: unknown,
  before?: AgentWorkflowInternalSnapshot): Promise<PreparedAgentStandaloneConfigurations> {
  const actor = structuredClone(actorInput), input = slotsSchema.parse(copyBoundedJson(value));
  if (before) storedSlots(before);
  const currentActor = await verifiedActor(actor);
  const initialPersonal: PreparedStandaloneExtensionSelection[] = [], retainedPersonal: PreparedPersonalWorkflowProviderTarget[] = [];
  const definitions: DefinitionStamp[] = [];
  const materialize = async (entry: AgentStandaloneEntryInput, configurationId?: string, choiceId?: string): Promise<StoredStandaloneExtensionTarget> => {
    if (entry.retainedBindingRef) {
      const target = retainedTarget(currentActor, before, configurationId, choiceId, entry);
      if (target.kind === 'personal') retainedPersonal.push(await verifyStoredPersonalWorkflowProviderTarget({ actor: currentActor,
        target: { binding: target.personalBinding, baseProviderRef: target.providerRef,
          boundProviderRef: target.boundProviderRef, bindingFingerprint: target.bindingFingerprint } }));
      return target;
    }
    if (entry.selection.target.kind === 'shared') return { kind: 'shared', source: entry.selection.source,
      connectionRef: entry.selection.target.connectionRef, bindingRevision: entry.selection.target.bindingRevision };
    const proof = await prepareStandaloneExtensionSelection(currentActor, {
      selection: entry.selection, requirement: entry.requirement, toolCap: entry.toolCap,
      ...(entry.accountSelectionRef === undefined ? {} : { accountSelectionRef: entry.accountSelectionRef }),
    });
    const fixed = getPreparedStandaloneExtensionBinding(proof, currentActor);
    if (fixed.mode !== 'fixed' || fixed.entry.target.kind !== 'personal' || fixed.entry.target.ownerUserId !== actor.userId) return denied();
    initialPersonal.push(proof);
    return fixed.entry.target;
  };
  const configurations: StoredStandaloneExtensionBinding[] = [];
  for (const slot of input) {
    if (slot.mode === 'fixed') {
      const configurationId = slot.entry.retainedBindingRef ? slot.configurationId!
        : `fixed:${createHash('sha256').update(extensionSelectionIdentity(slot.entry.selection)).digest('base64url')}`;
      if (slot.configurationId !== undefined && slot.configurationId !== configurationId) return denied('AGENT_EXTENSION_SLOT_INVALID');
      const target = await materialize(slot.entry, configurationId);
      configurations.push(parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId, mode: 'fixed',
        entry: { selection: slot.entry.selection, target, requirement: slot.entry.requirement, toolCap: slot.entry.toolCap } }));
    } else {
      const choices = [];
      for (const choice of slot.allowedChoices) choices.push({ choiceId: choice.choiceId, selection: choice.selection, toolCap: choice.toolCap,
        target: await materialize({ ...choice, requirement: slot.requirement }, slot.configurationId, choice.choiceId) });
      if (slot.personalPolicy?.source === 'mcp') definitions.push(...await definitionStamps(currentActor, slot.personalPolicy.serverDefinitionIds));
      configurations.push(parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: slot.configurationId,
        mode: 'selectable', source: slot.source, ...(slot.source === 'composio' ? { toolkit: slot.toolkit } : {}),
        requirement: slot.requirement, allowedChoices: choices, ...(slot.defaultChoiceId === undefined ? {} : { defaultChoiceId: slot.defaultChoiceId }),
        ...(slot.personalPolicy === undefined ? {} : { personalPolicy: slot.personalPolicy }) }));
    }
  }
  const slotRefs = new Set<string>(), identities = new Set<string>();
  for (const config of configurations) {
    if (slotRefs.has(config.configurationId)) return denied('AGENT_EXTENSION_SLOT_INVALID');
    slotRefs.add(config.configurationId);
    for (const choice of config.mode === 'fixed' ? [config.entry] : config.allowedChoices) {
      const identity = extensionSelectionIdentity(choice.selection);
      if (identities.has(identity)) return denied('AGENT_EXTENSION_SLOT_INVALID');
      identities.add(identity);
    }
  }
  if (actorKey(await verifiedActor(actor)) !== actorKey(currentActor)) return denied();
  const handle = Object.freeze({ kind: 'prepared_agent_standalone_configurations' as const, count: configurations.length });
  const record: Record = { actorKey: actorKey(actor), verifiedActorKey: actorKey(currentActor), configurations: freeze(configurations),
    initialPersonal, retainedPersonal, definitions, expiresAt: Date.now() + 5 * 60_000,
    ...(before ? { before: { agentId: before.agent.agentId, revision: before.agent.revision, workflowRevision: before.workflowRevision } } : {}) };
  records.set(handle, record);
  return handle;
}

/** Private materialized syntax, not a write or execution grant. */
export function getPreparedAgentStandaloneConfigurations(handle: PreparedAgentStandaloneConfigurations,
  actor: AgentManagementActor): readonly StoredStandaloneExtensionBinding[] {
  return recordFor(handle, actor).configurations;
}
export function getPreparedAgentStandaloneSharedReferences(handle: PreparedAgentStandaloneConfigurations, actor: AgentManagementActor): readonly string[] {
  const configs = recordFor(handle, actor).configurations;
  return Object.freeze([...new Set(configs.flatMap(config => (config.mode === 'fixed' ? [config.entry] : config.allowedChoices)
    .flatMap(choice => choice.target.kind === 'shared' ? [choice.target.connectionRef] : [])))].sort());
}

/** Reuses actual prepared personal proofs with the caller's transaction; no receipt survives preparation. */
export async function revalidatePreparedAgentStandalonePersonalConfigurations(handle: PreparedAgentStandaloneConfigurations,
  actor: AgentManagementActor, options: { database: SqlConnection }): Promise<void> {
  const record = recordFor(handle, actor), current = await verifiedActor(actor, options.database);
  if (actorKey(current) !== record.verifiedActorKey) return denied();
  for (const proof of record.initialPersonal) await revalidatePreparedStandaloneExtensionSelection(proof, current, options);
  for (const proof of record.retainedPersonal) await revalidatePreparedPersonalWorkflowProviderTarget(proof, options);
  await revalidateDefinitions(record, current);
  recordFor(handle, actor);
}

function validateShared(record: Record, actor: AgentManagementActor, agent: AgentProfile,
  authorizations: readonly IntegrationConnectionBindingAuthorization[]): void {
  for (const config of record.configurations) for (const choice of config.mode === 'fixed' ? [config.entry] : config.allowedChoices) {
    const target = choice.target;
    if (target.kind === 'personal') {
      if (agent.scopeType !== 'user' || target.ownerUserId !== actor.userId) return denied('AGENT_WORKFLOW_BINDING_DENIED');
      continue;
    }
    const current = authorizations.find(value => value.resource.connectionRef === target.connectionRef);
    if (!current?.canUse || current.actor.userId !== actor.userId || current.resource.status !== 'active'
      || (current.actor.workspaceId ?? null) !== (actor.workspaceId ?? null)
      || (Reflect.get(current.actor, 'projectId') ?? null) !== (actor.projectId ?? null)
      || current.actor.organizationId != null && current.actor.organizationId !== actor.organizationId
      || current.resource.source !== target.source || current.resource.bindingRevision !== target.bindingRevision
      || choice.selection.kind === 'composio' && (current.backend.source !== 'composio'
        || current.backend.toolkit !== choice.selection.toolkit || current.backend.accountBinding === 'pending')) {
      return denied('AGENT_WORKFLOW_BINDING_CHANGED');
    }
  }
}

/** Caller owns BEGIN/COMMIT and locks connections before the actual agent row. No fake target or cloned batch is accepted. */
export async function authorizePreparedAgentStandaloneConfigurationsOnConnection(handle: PreparedAgentStandaloneConfigurations,
  actor: AgentManagementActor, database: SqlConnection, batch: IntegrationConnectionBindingBatch,
  target: AgentProfile, options: { emailV2Configuration?: HeldEmailV2BindingConfiguration } = {}): Promise<readonly StoredStandaloneExtensionBinding[]> {
  const record = recordFor(handle, actor), currentActor = await verifiedActor(actor, database);
  if (actorKey(currentActor) !== record.verifiedActorKey) return denied();
  const current = await readAgentProfileOnConnection(database, target.agentId, true);
  if (!current || current.revision !== target.revision || current.scopeType !== target.scopeType
    || current.organizationId !== target.organizationId || current.ownerUserId !== target.ownerUserId
    || record.before && (record.before.agentId !== current.agentId || record.before.revision !== current.revision
      || record.before.workflowRevision !== current.workflowRevision)) return denied('AGENT_EXTENSION_TARGET_CHANGED');
  const authorizations = await authorizeIntegrationConnectionBindingsOnConnection(database, batch, current, 'configure', options);
  validateShared(record, currentActor, current, authorizations);
  await revalidateDefinitions(record, currentActor);
  recordFor(handle, actor);
  return record.configurations;
}

async function currentEditableActor(actor: AgentManagementActor,
  before: AgentWorkflowInternalSnapshot): Promise<AgentManagementActor> {
  const database = await openDb();
  try {
    const currentActor = await verifiedActor(actor, database);
    const current = await readAgentProfileOnConnection(database, before.agent.agentId);
    const access = await getAgentAccessOnConnection(database, currentActor.userId, before.agent.agentId,
      { organizationId: currentActor.organizationId, workspaceId: currentActor.workspaceId, projectId: currentActor.projectId });
    if (!current || !access.canEdit || current.revision !== before.agent.revision
      || current.workflowRevision !== before.workflowRevision) return denied('AGENT_EXTENSION_TARGET_CHANGED');
    return currentActor;
  } finally { await database.close(); }
}

/** Editable public slots contain no private targets or expiring account-choice receipts. */
export async function projectAgentStandaloneConfigurations(actorInput: AgentManagementActor,
  before: AgentWorkflowInternalSnapshot): Promise<readonly AgentStandaloneConfigurationInput[]> {
  const slots = storedSlots(before), captured = structuredClone(actorInput);
  const actor = await currentEditableActor(captured, before);
  for (const config of slots) for (const choice of config.mode === 'fixed' ? [config.entry] : config.allowedChoices) {
    if (choice.target.kind !== 'personal') continue;
    const target = choice.target;
    await verifyStoredPersonalWorkflowProviderTarget({ actor, target: { binding: target.personalBinding,
      baseProviderRef: target.providerRef, boundProviderRef: target.boundProviderRef,
      bindingFingerprint: target.bindingFingerprint } }, { checkProviderReadiness: false });
  }
  if (actorKey(await currentEditableActor(captured, before)) !== actorKey(actor)) return denied();
  return freeze(slots.map(config => {
    const publicChoice = (choice: { selection: AgentStandaloneEntryInput['selection']; target: StoredStandaloneExtensionTarget; toolCap: string[] | null },
      choiceId?: string) => {
      if (choice.target.kind === 'personal' && choice.target.ownerUserId !== actor.userId) return denied();
      return { selection: choice.selection, toolCap: choice.toolCap, retainedBindingRef: retentionRef(actor, before, config, choiceId) };
    };
    return agentStandaloneConfigurationInputSchema.parse(config.mode === 'fixed' ? { mode: 'fixed' as const, configurationId: config.configurationId,
      entry: { ...publicChoice(config.entry), requirement: config.entry.requirement } }
      : { mode: 'selectable' as const, configurationId: config.configurationId, source: config.source,
        ...(config.source === 'composio' ? { toolkit: config.toolkit } : {}), requirement: config.requirement,
        allowedChoices: config.allowedChoices.map(choice => ({ choiceId: choice.choiceId, ...publicChoice(choice, choice.choiceId) })),
        ...(config.defaultChoiceId === undefined ? {} : { defaultChoiceId: config.defaultChoiceId }),
        ...(config.personalPolicy === undefined ? {} : { personalPolicy: config.personalPolicy }) });
  }));
}
