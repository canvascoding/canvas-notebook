import 'server-only';

import { createHash } from 'node:crypto';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import type { StoredAgentWorkflowTarget } from '@/app/lib/agents/workflow-contracts';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { openDb } from '@/app/lib/db';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { readStoredAgentWorkspaceOnConnection } from '@/app/lib/pi/session-workspace-context';
import {
  getAuthorizedAgentWorkflowPackageSelections,
  reissueCapabilityPackageRuntimeBindings,
  isAuthorizedAgentWorkflowPackageSelections,
  type AuthorizedAgentWorkflowPackageSelections,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import { authorizeIntegrationConnection, revalidateAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { verifyStoredPersonalWorkflowProviderTarget } from '@/app/lib/integration-tools/workflow-personal-bindings';
import {
  readAcceptedTurnExtensionSelection,
  type AcceptedTurnExtensionSelection,
  type StoredAcceptedTurnExtensionSelection,
} from './accepted-turn-selection';
import { isExplicitAgentWorkflowVersion } from '@/app/lib/agents/workflow-version';
import { requireDelegationSource } from '@/app/lib/pi/delegation-policy';
import { schemaFingerprint } from '@/app/lib/integration-tools/schema';
import { getConfiguredStandaloneTurnFocus } from './standalone-runtime';
import { freeze, parseStoredStandaloneExtensionBinding } from './stored-contracts';
import type { ChatExtensionSelection, ExtensionPackageConnection, StandaloneExtensionSelection } from './contracts';
import { readDelegatedExtensionSource, type DelegatedFixedExtensionBinding, type HeldDelegatedExtensionSource } from './delegation-source';
import { resolveEffectiveExtensionContext } from './effective-context';
import { getConfiguredPackageTurnFocus } from './turn-package-bindings';

export type HeldAcceptedTurnRuntimeSelection = Readonly<{
  kind: 'accepted_turn_runtime_selection';
  fingerprint: string;
}>;
export type AcceptedTurnRuntimeSelectionData = Readonly<{
  publicSelection: StoredAcceptedTurnExtensionSelection['publicSelection'];
  privateFixedBindings: readonly StoredAcceptedTurnExtensionSelection['privateFixedBindings'][number][];
}>;
type Record = {
  namespace: string;
  data: AcceptedTurnRuntimeSelectionData;
  delegation?: { source: HeldDelegatedExtensionSource; delegationId: string };
  packageFocus?: readonly DelegatedExtensionPackageFocus[];
};
export type DelegatedExtensionPackageFocus = Pick<ExtensionPackageConnection, 'package' | 'declarationPath' | 'capabilityId' | 'alternativeKey'>
  & { connectionSelection: StandaloneExtensionSelection; target: StoredAgentWorkflowTarget; toolCap: readonly string[] | null; required: boolean };
const host = globalThis as typeof globalThis & {
  __canvasAcceptedTurnRuntimeSelectionsV1?: WeakMap<object, Record>;
};
const records = host.__canvasAcceptedTurnRuntimeSelectionsV1 ??= new WeakMap<object, Record>();
type DelegationFrame = { namespace: string; delegationId: string; taskFingerprint: string };
const frameHost = globalThis as typeof globalThis & { __canvasDelegatedExtensionPreparationFramesV1?: WeakMap<object, Map<string, DelegationFrame>> };
const delegationFrames = frameHost.__canvasDelegatedExtensionPreparationFramesV1 ??= new WeakMap<object, Map<string, DelegationFrame>>();

/** Metadata admission only. Fresh runtime policy must still verify every source. */
export function hasIssuedTurnExtensionSource(context: AgentExecutionContext): boolean {
  if (!context.turnExtensionSource) return false;
  const issued = records.get(context.turnExtensionSource);
  if (!issued || issued.namespace !== turnNamespace(context)
    || (issued.delegation ? issued.delegation.source !== context.delegatedExtensionSource : Boolean(context.delegatedExtensionSource))) return denied();
  return Boolean(issued.delegation) || issued.data.publicSelection.selections.length > 0;
}

function denied(): never {
  throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The accepted selection is unavailable for this current agent turn.', 403);
}

function actorNamespace(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId, context.organizationId, context.workspaceId,
    context.workspaceType, context.workspaceRoot, context.workspaceRootRelativePath, context.projectId, context.customerId,
    context.canWrite, context.canDelete, context.canShare, context.legacy]);
}

function turnNamespace(context: AgentExecutionContext): string {
  if (!context.agentTurnId?.trim() || !context.userId?.trim() || !context.agentId?.trim()
    || !context.sessionId?.trim() || !context.workspaceId?.trim()) return denied();
  return JSON.stringify([actorNamespace(context), context.agentTurnId, context.turnExtensions ?? null]);
}

function actorFor(context: AgentExecutionContext): AgentManagementActor {
  return Object.freeze({ userId: context.userId, source: 'system', sourceAgentId: context.agentId, sessionId: context.sessionId,
    organizationId: context.organizationId, workspaceId: context.workspaceId, projectId: context.projectId });
}

/** Actual persisted session and current SQL actor; never bootstrap or choose another workspace. */
async function assertCurrentActor(context: AgentExecutionContext): Promise<void> {
  const database = await openDb();
  try {
    const workspace = await readStoredAgentWorkspaceOnConnection(database, { userId: context.userId, sessionId: context.sessionId,
      agentId: context.agentId!, workspaceId: context.workspaceId, permissions: ['canRead', 'canRunAgent'] });
    const actor = await resolveVerifiedAgentActorContextOnConnection(actorFor(context), database);
    if (actor.userId !== context.userId || actor.organizationId !== context.organizationId
      || actor.context.workspaceId !== context.workspaceId || (actor.context.projectId ?? null) !== context.projectId
      || workspace.workspaceId !== context.workspaceId || workspace.workspaceType !== context.workspaceType
      || workspace.organizationId !== context.organizationId || (workspace.projectId ?? null) !== context.projectId
      || (workspace.customerId ?? null) !== context.customerId || workspace.rootPath !== context.workspaceRoot
      || (workspace.rootRelativePath ?? null) !== context.workspaceRootRelativePath || workspace.legacy !== context.legacy
      || workspace.permissions.canWrite !== context.canWrite || workspace.permissions.canDelete !== context.canDelete
      || workspace.permissions.canCreatePublicLinks !== context.canShare) return denied();
  } finally {
    await database.close();
  }
}

async function verifyFixedSources(context: AgentExecutionContext,
  bindings: readonly DelegatedFixedExtensionBinding[]): Promise<unknown[]> {
  const actor = actorFor(context), revisions: unknown[] = [];
  const shared: Array<Awaited<ReturnType<typeof authorizeIntegrationConnection>>> = [];
  for (const binding of bindings) {
    const { selection, target } = binding.entry;
    if (target.kind === 'personal') {
      if (target.ownerUserId !== context.userId) return denied();
      await verifyStoredPersonalWorkflowProviderTarget({ actor, target: { binding: target.personalBinding,
        baseProviderRef: target.providerRef, boundProviderRef: target.boundProviderRef, bindingFingerprint: target.bindingFingerprint } },
      { checkProviderReadiness: false });
      revisions.push([target.boundProviderRef, target.bindingFingerprint]);
    } else {
      const current = await authorizeIntegrationConnection({ userId: context.userId, organizationId: context.organizationId,
        workspaceId: context.workspaceId, agentId: context.agentId, sessionId: context.sessionId,
        policyRevision: 'accepted-turn-source' }, target.connectionRef, 'use');
      if (!current.access.canUse || current.resource.status !== 'active' || current.resource.source !== target.source
        || current.resource.bindingRevision !== target.bindingRevision
        || selection.kind === 'composio' && (current.backend.source !== 'composio'
          || current.backend.toolkit !== selection.toolkit || current.backend.accountBinding === 'pending')) return denied();
      shared.push(current);
      revisions.push([target.connectionRef, target.bindingRevision, current.authorizationRevision]);
    }
  }
  for (const binding of bindings) if (binding.entry.target.kind === 'personal') {
    const target = binding.entry.target;
    await verifyStoredPersonalWorkflowProviderTarget({ actor, target: { binding: target.personalBinding,
      baseProviderRef: target.providerRef, boundProviderRef: target.boundProviderRef, bindingFingerprint: target.bindingFingerprint } },
    { checkProviderReadiness: false });
  }
  for (const current of shared) await revalidateAuthorizedIntegrationConnection(current, 'use');
  return revisions;
}

/**
 * The only admission is an actual issued intake handle. A private JSON DTO,
 * owned-session string or copied handle never substitutes for that provenance.
 * Phase4 must add a separate guarded server-owned message reader for replay.
 */
export async function reissueAcceptedTurnRuntimeSelection(contextInput: AgentExecutionContext,
  acceptedHandle: AcceptedTurnExtensionSelection, intakeContext: AgentExecutionContext,
  options: { packageSelection: AuthorizedAgentWorkflowPackageSelections }): Promise<HeldAcceptedTurnRuntimeSelection> {
  const accepted = readAcceptedTurnExtensionSelection(acceptedHandle, intakeContext);
  const context = { ...contextInput, ...(contextInput.turnExtensions
    ? { turnExtensions: structuredClone(contextInput.turnExtensions) } : {}) };
  const namespace = turnNamespace(context);
  const packageSelection = options.packageSelection;
  if (actorNamespace(intakeContext) !== actorNamespace(context)
    || JSON.stringify(context.turnExtensions) !== JSON.stringify(accepted.publicSelection)
    || !isAuthorizedAgentWorkflowPackageSelections(packageSelection, context)) return denied();
  await assertCurrentActor(context);
  const revisions = await verifyFixedSources(context, accepted.privateFixedBindings);
  await assertCurrentActor(context);
  readAcceptedTurnExtensionSelection(acceptedHandle, intakeContext);
  if (turnNamespace(contextInput) !== namespace || actorNamespace(intakeContext) !== actorNamespace(context)
    || !isAuthorizedAgentWorkflowPackageSelections(packageSelection, context)) return denied();
  const fingerprint = createHash('sha256').update(JSON.stringify([namespace, acceptedHandle.fingerprint,
    packageSelection.fingerprint, revisions])).digest('hex');
  const handle = Object.freeze({ kind: 'accepted_turn_runtime_selection' as const, fingerprint });
  records.set(handle, { namespace, data: Object.freeze({ publicSelection: accepted.publicSelection,
    privateFixedBindings: accepted.privateFixedBindings }) });
  return handle;
}

/** Exact private metadata for the current turn, not cached execution permission. */
export function readAcceptedTurnRuntimeSelection(handle: HeldAcceptedTurnRuntimeSelection,
  context: AgentExecutionContext, packageSelection: AuthorizedAgentWorkflowPackageSelections): AcceptedTurnRuntimeSelectionData {
  const record = handle && typeof handle === 'object' ? records.get(handle) : undefined;
  if (!record || record.namespace !== turnNamespace(context)
    || (record.delegation ? record.delegation.source !== context.delegatedExtensionSource : Boolean(context.delegatedExtensionSource))
    || !isAuthorizedAgentWorkflowPackageSelections(packageSelection, context)) return denied();
  return record.data;
}

async function currentDelegationTask(source: HeldDelegatedExtensionSource, child: AgentExecutionContext,
  delegationId: string): Promise<string> {
  const parent = readDelegatedExtensionSource(source).parentContext;
  if (!delegationId.trim() || child.userId !== parent.userId || child.sessionId === parent.sessionId
    || child.agentTurnId === parent.agentTurnId || child.organizationId !== parent.organizationId
    || child.workspaceId !== parent.workspaceId || child.workspaceType !== parent.workspaceType
    || child.projectId !== parent.projectId || child.customerId !== parent.customerId
    || child.workspaceRoot !== parent.workspaceRoot || child.workspaceRootRelativePath !== parent.workspaceRootRelativePath
    || child.legacy !== parent.legacy || child.canWrite !== parent.canWrite || child.canDelete !== parent.canDelete
    || child.canShare !== parent.canShare) return denied();
  await requireDelegationSource({ userId: parent.userId, sourceSessionId: parent.sessionId, sourceAgentId: parent.agentId });
  await assertCurrentActor(parent);
  await assertCurrentActor(child);
  const database = await openDb();
  try {
    const activeUser = await database.get('SELECT id FROM "user" WHERE id=$1 AND (banned IS NULL OR banned=0) LIMIT 1', [child.userId]);
    if (!activeUser) return denied();
    const rows = await database.all(`SELECT d.id,d.user_id,d.source_session_id,d.source_agent_id,d.source_agent_turn_identity,
      d.worker_session_id,d.target_agent_id,d.worker_type,d.toolsets_json,d.run_owner_id,
      c.agent_id AS child_agent,c.parent_session_id,c.session_kind,c.delegation_depth
      FROM pi_delegations d INNER JOIN pi_sessions c ON c.session_id=d.worker_session_id AND c.user_id=d.user_id
      WHERE d.user_id=$1 AND d.worker_session_id=$2 AND d.status='running' AND d.cancel_requested_at IS NULL
        AND c.archived_at IS NULL LIMIT 2`, [child.userId, child.sessionId]) as Array<{ [key: string]: unknown }>;
    const task = rows[0];
    if (rows.length !== 1 || task.id !== delegationId || task.source_session_id !== parent.sessionId
      || task.source_agent_id !== parent.agentId || task.source_agent_turn_identity !== parent.agentTurnId
      || task.child_agent !== child.agentId || task.parent_session_id !== parent.sessionId
      || task.session_kind !== 'delegation_worker' || Number(task.delegation_depth) !== 1
      || task.worker_type === 'ephemeral' && (task.target_agent_id !== null || child.agentId !== parent.agentId)
      || task.worker_type === 'managed' && task.target_agent_id !== child.agentId
      || !['ephemeral', 'managed'].includes(String(task.worker_type))) return denied();
    return schemaFingerprint(task);
  } finally { await database.close(); }
}

/** Only a real persisted child/task can establish this preparation frame. No public grant setter exists. */
async function prepareDelegatedFrame(source: HeldDelegatedExtensionSource, context: AgentExecutionContext,
  delegationId: string): Promise<void> {
  const taskFingerprint = await currentDelegationTask(source, context, delegationId);
  const namespace = turnNamespace(context);
  const frames = delegationFrames.get(source) ?? new Map<string, DelegationFrame>();
  frames.set(namespace, { namespace, delegationId, taskFingerprint });
  delegationFrames.set(source, frames);
}

/** Package admission consumes only the privately SQL-validated frame established during source issuance. */
export function assertPreparedDelegatedExtensionSourceFrame(source: HeldDelegatedExtensionSource,
  context: AgentExecutionContext): void {
  readDelegatedExtensionSource(source);
  const frame = delegationFrames.get(source)?.get(turnNamespace(context));
  if (!frame || context.delegatedExtensionSource !== source) return denied();
}

/** Validate the actual child source/task link before using the original parent as a current policy ceiling. */
export function readDelegatedTurnRuntimeParentSource(context: AgentExecutionContext,
  delegationId: string): HeldDelegatedExtensionSource | null {
  if (!context.delegatedExtensionSource) {
    if (context.turnExtensionSource && records.get(context.turnExtensionSource)?.delegation) return denied();
    return null;
  }
  const record = context.turnExtensionSource && records.get(context.turnExtensionSource);
  if (!record || record.namespace !== turnNamespace(context) || record.delegation?.delegationId !== delegationId
    || record.delegation.source !== context.delegatedExtensionSource) return denied();
  readDelegatedExtensionSource(record.delegation.source);
  return record.delegation.source;
}

async function childFixedBindings(source: HeldDelegatedExtensionSource, context: AgentExecutionContext,
  selection: AuthorizedAgentWorkflowPackageSelections): Promise<{ bindings: readonly DelegatedFixedExtensionBinding[];
    packageFocus: readonly DelegatedExtensionPackageFocus[] }> {
  const data = readDelegatedExtensionSource(source);
  if (!isAuthorizedAgentWorkflowPackageSelections(selection, context)) return denied();
  const fixed = isExplicitAgentWorkflowVersion(selection.workflowVersion);
  const result: DelegatedFixedExtensionBinding[] = [], packageFocus: DelegatedExtensionPackageFocus[] = [];
  for (const binding of data.privateFixedBindings) {
    const selected = fixed ? getConfiguredStandaloneTurnFocus(context, selection, binding.entry) : null;
    const packageChoice = getConfiguredPackageTurnFocus(context, selection, binding.entry);
    if (fixed && !selected?.choice && !packageChoice) continue;
    const cap = selected?.choice && packageChoice ? selected.choice.toolCap === null || packageChoice.toolCap === null ? null
      : [...new Set([...selected.choice.toolCap, ...packageChoice.toolCap])].sort() : selected?.choice?.toolCap ?? packageChoice?.toolCap;
    const choice = selected?.choice ?? (packageChoice ? { selection: binding.entry.selection,
      target: packageChoice.target, toolCap: packageChoice.toolCap } : binding.entry);
    const required = Boolean(selected?.required || packageChoice?.required || binding.entry.requirement === 'required');
    if (packageChoice) for (const mapping of packageChoice.packageConnections) {
      const previous = packageFocus.find(focus => JSON.stringify([focus.package, focus.declarationPath, focus.capabilityId])
        === JSON.stringify([mapping.package, mapping.declarationPath, mapping.capabilityId]));
      if (previous && JSON.stringify(previous.connectionSelection) !== JSON.stringify(binding.entry.selection)) return denied();
      if (!previous) packageFocus.push({ ...mapping, connectionSelection: binding.entry.selection,
        target: packageChoice.target, toolCap: packageChoice.toolCap, required: packageChoice.required });
    }
    const focused = parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId: binding.configurationId,
      mode: 'fixed', entry: { selection: choice.selection, target: choice.target.kind === 'shared' ? { kind: 'shared', source: choice.target.source,
        connectionRef: choice.target.connectionRef, bindingRevision: choice.target.bindingRevision } : choice.target,
        toolCap: cap === undefined ? choice.toolCap : cap, requirement: required ? 'required' : 'optional' } });
    if (focused.mode !== 'fixed') return denied();
    result.push(focused);
  }
  return { bindings: Object.freeze(result), packageFocus: freeze(packageFocus) };
}

function childPublicSelection(source: HeldDelegatedExtensionSource, childSelection: AuthorizedAgentWorkflowPackageSelections,
  bindings: readonly DelegatedFixedExtensionBinding[]): ChatExtensionSelection {
  const original = readDelegatedExtensionSource(source).publicSelection;
  const exact = new Set(bindings.map(binding => JSON.stringify(binding.entry.selection)));
  const selections = original.selections.filter(entry => {
    const chosen = entry.selection;
    if (chosen.kind !== 'plugin' && chosen.kind !== 'skill') return exact.has(JSON.stringify(chosen));
    return !isExplicitAgentWorkflowVersion(childSelection.workflowVersion) || childSelection.packages.some(pkg =>
      pkg.resourceRef === chosen.package.resourceRef && pkg.publishedRevisionRef === chosen.package.publishedRevisionRef
      && pkg.checksum === chosen.package.checksum);
  });
  const packagePins = new Set(selections.flatMap(entry => entry.selection.kind === 'plugin' || entry.selection.kind === 'skill'
    ? [JSON.stringify(entry.selection.package)] : []));
  const connectionSelections = new Set(selections.filter(entry => entry.selection.kind === 'mcp' || entry.selection.kind === 'composio')
    .map(entry => JSON.stringify(entry.selection)));
  return freeze({ version: 1, origin: 'turn_reference', selections: structuredClone(selections),
    ...(original.packageConnections ? { packageConnections: structuredClone(original.packageConnections.filter(mapping =>
      packagePins.has(JSON.stringify(mapping.package)) && connectionSelections.has(JSON.stringify(mapping.connectionSelection)))) } : {}) });
}

/** Reissue only original privately held targets for an actually stored, active child task. */
export async function reissueDelegatedTurnRuntimeSelection(source: HeldDelegatedExtensionSource, contextInput: AgentExecutionContext,
  options: { packageSelection: AuthorizedAgentWorkflowPackageSelections; delegationId: string }): Promise<HeldAcceptedTurnRuntimeSelection> {
  const context = { ...contextInput, ...(contextInput.turnExtensions ? { turnExtensions: structuredClone(contextInput.turnExtensions) } : {}) };
  const selection = options.packageSelection, namespace = turnNamespace(context);
  const data = readDelegatedExtensionSource(source);
  if (context.delegatedExtensionSource !== source || !isAuthorizedAgentWorkflowPackageSelections(selection, context)) return denied();
  await prepareDelegatedFrame(source, context, options.delegationId);
  const parentSelection = await getAuthorizedAgentWorkflowPackageSelections(data.parentContext);
  if (!isAuthorizedAgentWorkflowPackageSelections(parentSelection, data.parentContext)) return denied();
  // Verify all original sources before filtering. Optional/unsupported targets
  // cannot disappear after revocation and leave a generic policy behind.
  const parentRevisions = await verifyFixedSources(data.parentContext, data.privateFixedBindings);
  const { bindings, packageFocus } = await childFixedBindings(source, context, selection);
  const expectedPublic = childPublicSelection(source, selection, bindings);
  if (JSON.stringify(context.turnExtensions ?? { version: 1, origin: 'turn_reference', selections: [] }) !== JSON.stringify(expectedPublic)) return denied();
  const childRevisions = await verifyFixedSources(context, bindings);
  const frame = delegationFrames.get(source)?.get(namespace);
  if (!frame || await currentDelegationTask(source, context, options.delegationId) !== frame.taskFingerprint
    || turnNamespace(contextInput) !== namespace || !isAuthorizedAgentWorkflowPackageSelections(selection, context)) return denied();
  readDelegatedExtensionSource(source);
  const fingerprint = createHash('sha256').update(JSON.stringify([namespace, source.fingerprint, options.delegationId,
    selection.fingerprint, parentSelection.fingerprint, parentRevisions, childRevisions])).digest('hex');
  const handle = Object.freeze({ kind: 'accepted_turn_runtime_selection' as const, fingerprint });
  records.set(handle, { namespace, delegation: { source, delegationId: options.delegationId }, packageFocus,
    data: Object.freeze({ publicSelection: expectedPublic, privateFixedBindings: bindings }) });
  return handle;
}

/** One same-proof compilation for the child prompt, package roots and integration routes. */
export async function resolveDelegatedExtensionContextSource(source: HeldDelegatedExtensionSource, contextInput: AgentExecutionContext,
  options: { delegationId: string }): Promise<AgentExecutionContext> {
  readDelegatedExtensionSource(source);
  const base: AgentExecutionContext = { ...contextInput, turnExtensions: undefined, turnExtensionSource: undefined,
    effectiveExtensions: undefined, delegatedExtensionSource: source };
  await prepareDelegatedFrame(source, base, options.delegationId);
  const baseline = await getAuthorizedAgentWorkflowPackageSelections(base);
  const { bindings } = await childFixedBindings(source, base, baseline);
  const context: AgentExecutionContext = { ...base, turnExtensions: childPublicSelection(source, baseline, bindings) };
  await prepareDelegatedFrame(source, context, options.delegationId);
  const packageSelection = await getAuthorizedAgentWorkflowPackageSelections(context, { delegationPackageSource: source });
  context.turnExtensionSource = await reissueDelegatedTurnRuntimeSelection(source, context,
    { packageSelection, delegationId: options.delegationId });
  const held = await reissueCapabilityPackageRuntimeBindings(readDelegatedExtensionSource(source).parentContext, context);
  return resolveEffectiveExtensionContext(held, { packageSelection, preserveIssuedBindings: true });
}

/** Private declaration focus comes from the SQL-bound child issuer, never an array in chat arguments. */
export function readDelegatedExtensionPackageFocus(context: AgentExecutionContext,
  selection: AuthorizedAgentWorkflowPackageSelections): readonly DelegatedExtensionPackageFocus[] {
  if (!context.delegatedExtensionSource) return [];
  if (!isAuthorizedAgentWorkflowPackageSelections(selection, context)) return denied();
  const record = context.turnExtensionSource && records.get(context.turnExtensionSource);
  if (!record || record.namespace !== turnNamespace(context)
    || record.delegation?.source !== context.delegatedExtensionSource) return denied();
  readDelegatedExtensionSource(record.delegation.source);
  return record.packageFocus ?? [];
}
