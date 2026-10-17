import 'server-only';

import { z } from 'zod';
import { openDb } from '@/app/lib/db';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import { getAgentAccessOnConnection } from './access';
import { auditAgentAction, type AgentManagementActor } from './management-actions';
import {
  holdAgentGrantAuthority,
  readAgentWorkflowPreferenceSnapshot,
  readManagedAgentWorkflow,
  readManagedAgentWorkflowOnConnection,
} from './workflow-configuration';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot, type AgentWorkflowChoice } from './workflow-contracts';
import {
  authorizeIntegrationConnectionBindingsOnConnection,
  lockIntegrationConnectionBindingsOnConnection,
  narrowIntegrationConnectionBindingBatchOnConnection,
  type IntegrationConnectionBindingAuthorization,
} from '@/app/lib/integration-tools/connections/store';
import {
  revalidatePreparedPersonalWorkflowProviderTarget,
  verifyStoredPersonalWorkflowProviderTarget,
  type PreparedPersonalWorkflowProviderTarget,
} from '@/app/lib/integration-tools/workflow-personal-bindings';
import {
  standaloneExtensionInputSchema,
  type StandaloneExtensionInput,
} from '@/app/lib/capabilities/extensions/contracts';
import { createStandaloneExtensionSlotRef, isStandaloneExtensionSlotRef } from '@/app/lib/capabilities/extensions/standalone-reference';
import {
  getPreparedStandaloneExtensionBinding,
  prepareStandaloneExtensionSelection,
  revalidatePreparedStandaloneExtensionSelection,
  type PreparedStandaloneExtensionSelection,
} from '@/app/lib/capabilities/extensions/standalone-preparation';
import {
  copyBoundedJson,
  parseStoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionTarget,
} from '@/app/lib/capabilities/extensions/stored-contracts';

export type SetManagedAgentStandaloneChoiceInput = {
  actor: AgentManagementActor;
  agentId: string;
  capabilityKey: string;
  expectedWorkflowRevision: number;
  expectedPreferenceRevision: number;
  choiceId?: string | null;
  standaloneSelection?: StandaloneExtensionInput;
};
export type ManagedAgentStandaloneChoiceResult = {
  agentId: string;
  workflowRevision: number;
  preferenceRevision: number;
};

const identifier = z.string().min(1).max(256)
  .refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.object({
  agentId: identifier,
  capabilityKey: z.string().refine(isStandaloneExtensionSlotRef),
  expectedWorkflowRevision: revision.refine(value => value > 0),
  expectedPreferenceRevision: revision,
  choiceId: identifier.nullable().optional(),
  standaloneSelection: standaloneExtensionInputSchema.optional(),
}).strict().refine(value => (value.choiceId !== undefined) !== (value.standaloneSelection !== undefined));
type SelectableSlot = Extract<StoredStandaloneExtensionBinding, { mode: 'selectable' }>;

function fail(code: string, message: string, status = 409): never {
  throw new AgentWorkflowError(code, message, status);
}

function namespace(actor: AgentManagementActor): string {
  return JSON.stringify([actor.userId, actor.organizationId ?? null, actor.workspaceId ?? null,
    actor.projectId ?? null, actor.sourceAgentId ?? null, actor.sessionId ?? null]);
}

function selectableSlot(snapshot: AgentWorkflowInternalSnapshot, capabilityKey: string): SelectableSlot {
  const matches: StoredStandaloneExtensionBinding[] = [];
  for (const binding of snapshot.bindings) {
    if (binding.resourceType !== 'connection') continue;
    if (!binding.standaloneConfiguration) fail('AGENT_WORKFLOW_CORRUPT', 'The stored standalone slot is unavailable.');
    const configuration = parseStoredStandaloneExtensionBinding(binding.standaloneConfiguration);
    const source = configuration.mode === 'fixed' ? configuration.entry.selection.source : configuration.source;
    const toolkit = configuration.mode === 'fixed'
      ? configuration.entry.selection.kind === 'composio' ? configuration.entry.selection.toolkit : undefined
      : configuration.toolkit;
    const exactRef = createStandaloneExtensionSlotRef({ configurationId: configuration.configurationId, source,
      ...(toolkit === undefined ? {} : { toolkit }) });
    if (binding.resourceId !== exactRef) fail('AGENT_WORKFLOW_CORRUPT', 'The stored standalone slot is inconsistent.');
    if (exactRef === capabilityKey) matches.push(configuration);
  }
  if (matches.length !== 1) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose a standalone slot from the current agent configuration.', 400);
  const slot = matches[0];
  if (slot.mode !== 'selectable') fail('AGENT_WORKFLOW_CHOICE_DENIED', 'This connection is centrally fixed.', 403);
  return slot;
}

function validateSharedChoice(target: StoredStandaloneExtensionTarget,
  selection: SelectableSlot['allowedChoices'][number]['selection'],
  authorizations: readonly IntegrationConnectionBindingAuthorization[]): void {
  if (target.kind !== 'shared') return;
  const actual = authorizations.find(authorization => authorization.resource.connectionRef === target.connectionRef);
  if (!actual?.canUse || actual.resource.status !== 'active' || actual.resource.source !== target.source
    || actual.resource.bindingRevision !== target.bindingRevision
    || selection.kind === 'composio' && (actual.backend.source !== 'composio'
      || actual.backend.toolkit !== selection.toolkit || actual.backend.accountBinding === 'pending')) {
    fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected connection changed or needs setup.');
  }
}

/** Save only the current user's choice. An accepted slot never changes central bindings, grants or caps. */
export async function setManagedAgentStandaloneChoice(input: SetManagedAgentStandaloneChoiceInput): Promise<ManagedAgentStandaloneChoiceResult> {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['actor', 'agentId', 'capabilityKey',
    'expectedWorkflowRevision', 'expectedPreferenceRevision', 'choiceId', 'standaloneSelection'].includes(key))) {
    fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose one permitted connection or explicitly clear your choice.', 400);
  }
  const actorInput = structuredClone(input.actor);
  let request: z.infer<typeof requestSchema>;
  try {
    const { actor: _actor, ...intent } = input;
    request = requestSchema.parse(copyBoundedJson(intent));
  } catch {
    fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose one exact permitted selection using current revisions.', 400);
  }
  const snapshot = await readManagedAgentWorkflow(actorInput, request.agentId);
  if (!snapshot.access.canUse || snapshot.workflowVersion !== 2) {
    fail('AGENT_ACCESS_DENIED', 'Current agent use is required to save your own standalone choice.', 403);
  }
  if (snapshot.workflowRevision !== request.expectedWorkflowRevision) {
    fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed.');
  }
  const slot = selectableSlot(snapshot, request.capabilityKey);
  const preflight = await openDb();
  let actor: AgentManagementActor;
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(actorInput, preflight);
    actor = { ...actorInput, organizationId: verified.organizationId,
      workspaceId: verified.context.workspaceId ?? null, projectId: verified.context.projectId ?? null };
  } finally {
    await preflight.close();
  }
  let preference: AgentWorkflowChoice | null = null;
  let target: StoredStandaloneExtensionTarget | undefined;
  let selectedIdentity: SelectableSlot['allowedChoices'][number]['selection'] | undefined;
  let initialPersonal: PreparedStandaloneExtensionSelection | undefined;
  let centralPersonal: PreparedPersonalWorkflowProviderTarget | undefined;
  if (request.standaloneSelection !== undefined) {
    const selected = request.standaloneSelection, policy = slot.personalPolicy;
    if (!policy || selected.selection.target.kind !== 'personal' || selected.selection.source !== policy.source
      || policy.source === 'composio' && (selected.selection.kind !== 'composio' || selected.selection.toolkit !== policy.toolkit)
      || selected.requirement !== slot.requirement || JSON.stringify(selected.toolCap) !== JSON.stringify(policy.toolCap)) {
      fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose your own connection within this slot’s exact personal policy.', 403);
    }
    initialPersonal = await prepareStandaloneExtensionSelection(actor!, selected);
    const materialized = getPreparedStandaloneExtensionBinding(initialPersonal, actor!);
    if (materialized.mode !== 'fixed' || materialized.entry.target.kind !== 'personal'
      || materialized.entry.target.ownerUserId !== actor!.userId) {
      fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose your own personal connection.', 403);
    }
    target = materialized.entry.target;
    if (policy.source === 'mcp' && (target.personalBinding.source !== 'mcp'
      || !target.personalBinding.serverDefinitionId || !policy.serverDefinitionIds.includes(target.personalBinding.serverDefinitionId))) {
      fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose your own connection from an explicitly approved MCP definition.', 403);
    }
    selectedIdentity = materialized.entry.selection;
    preference = { workflowRevision: request.expectedWorkflowRevision, personalTarget: target, standaloneSelection: selectedIdentity };
  } else if (request.choiceId !== null && request.choiceId !== undefined) {
    const allowed = slot.allowedChoices.find(choice => choice.choiceId === request.choiceId);
    if (!allowed) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose a connection from the central allowlist.', 403);
    target = allowed.target;
    selectedIdentity = allowed.selection;
    if (target.kind === 'personal') {
      if (target.ownerUserId !== actor!.userId || snapshot.agent.scopeType === 'organization') {
        fail('AGENT_WORKFLOW_CHOICE_DENIED', 'The creator’s personal account is unavailable to this user.', 403);
      }
      centralPersonal = await verifyStoredPersonalWorkflowProviderTarget({ actor: actor!, target: {
        binding: target.personalBinding, baseProviderRef: target.providerRef,
        boundProviderRef: target.boundProviderRef, bindingFingerprint: target.bindingFingerprint,
      } });
    }
    preference = { workflowRevision: request.expectedWorkflowRevision, choiceId: allowed.choiceId };
  }
  const contextSources = await (await import('./extension-context-package-metadata')).prepareAgentExtensionContextPackageSources(actor!, snapshot);
  const refs = [...(target?.kind === 'shared' ? [target.connectionRef] : []),
    ...(await import('./extension-context-provider-metadata')).collectAgentExtensionContextSharedReferences(snapshot)];
  const database = await openDb();
  let preferenceRevision: number;
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor!, database, { lock: true });
    const currentActor = { ...actor!, organizationId: verified.organizationId,
      workspaceId: verified.context.workspaceId ?? null, projectId: verified.context.projectId ?? null };
    if (namespace(currentActor) !== namespace(actor!)) fail('AGENT_ACCESS_DENIED', 'The current actor context changed.', 403);
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: actor!.userId, ...verified.context }, refs);
    const revalidatePersonal = async () => {
      if (initialPersonal) await revalidatePreparedStandaloneExtensionSelection(initialPersonal, actor!, { database });
      if (centralPersonal) await revalidatePreparedPersonalWorkflowProviderTarget(centralPersonal, { database });
    };
    await revalidatePersonal();
    const { withAgentExtensionContextPackageSources } = await import('./extension-context-package-metadata');
    preferenceRevision = await withAgentExtensionContextPackageSources(database, actor!, contextSources, async () => {
      await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [snapshot.agent.agentId]);
      const current = await readManagedAgentWorkflowOnConnection(database, snapshot.agent.agentId);
      await holdAgentGrantAuthority(database, actor!, current.agent);
      if (current.workflowVersion !== 2 || current.workflowRevision !== request.expectedWorkflowRevision
        || current.agent.revision !== snapshot.agent.revision) {
        fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed.');
      }
      if (!(await getAgentAccessOnConnection(database, actor!.userId, current.agent.agentId, verified.context)).canUse) {
        fail('AGENT_ACCESS_DENIED', 'Agent use was revoked.', 403);
      }
      const currentSlot = selectableSlot(current, request.capabilityKey);
      if (JSON.stringify(currentSlot) !== JSON.stringify(slot)) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The configured slot changed.');
      const selectedBatch = await narrowIntegrationConnectionBindingBatchOnConnection(database, batch,
        target?.kind === 'shared' ? [target.connectionRef] : []);
      const authorizations = await authorizeIntegrationConnectionBindingsOnConnection(database, selectedBatch, current.agent, 'read');
      if (target && selectedIdentity) validateSharedChoice(target, selectedIdentity, authorizations);
      const previous = await database.get('SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2 FOR UPDATE',
        [current.agent.agentId, actor!.userId]) as Record<string, unknown> | undefined;
      const preferences = readAgentWorkflowPreferenceSnapshot(previous);
      if (preferences.revision !== request.expectedPreferenceRevision) {
        fail('AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT', 'Your saved choice changed. Reload it before saving.');
      }
      const choices = { ...preferences.choices };
      if (preference) choices[request.capabilityKey] = preference;
      else delete choices[request.capabilityKey];
      const encoded = JSON.stringify({ ...preferences.json, workflowChoices: choices });
      if (Buffer.byteLength(encoded) > 1_048_576) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'The stored choices exceed their limit.', 400);
      await revalidatePersonal();
      const now = Date.now();
      const written = previous
        ? await database.get(`UPDATE agent_user_preferences SET preferences_json=$1,revision=revision+1,updated_at=$2
            WHERE agent_id=$3 AND user_id=$4 AND revision=$5 AND preferences_json=$6 RETURNING revision`,
        [encoded, now, current.agent.agentId, actor!.userId, request.expectedPreferenceRevision, previous.preferences_json])
        : await database.get(`INSERT INTO agent_user_preferences(agent_id,user_id,preferences_json,revision,created_at,updated_at)
            VALUES($1,$2,$3,1,$4,$4) ON CONFLICT(agent_id,user_id) DO NOTHING RETURNING revision`,
        [current.agent.agentId, actor!.userId, encoded, now]);
      const parsedRevision = revision.safeParse(written && typeof written === 'object' ? Number(Reflect.get(written, 'revision')) : undefined);
      if (!parsedRevision.success || parsedRevision.data !== request.expectedPreferenceRevision + 1) {
        fail('AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT', 'Your saved choice changed. Reload it before saving.');
      }
      const { assertManagedAgentExtensionContextOnConnection } = await import('./extension-context-preflight');
      await assertManagedAgentExtensionContextOnConnection({ database, actor: actor!, agentId: current.agent.agentId, batch, purpose: 'read' });
      await revalidatePersonal();
      return parsedRevision.data;
    });
    await database.run('COMMIT');
  } catch (error) {
    await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined);
    throw error;
  } finally {
    await database.close();
  }
  await auditAgentAction({ actor: actor!, agentId: snapshot.agent.agentId, action: 'agent.update_workflow_choice',
    input: { capabilityKey: request.capabilityKey }, output: { workflowRevision: request.expectedWorkflowRevision, preferenceRevision } });
  return { agentId: snapshot.agent.agentId, workflowRevision: request.expectedWorkflowRevision, preferenceRevision };
}
