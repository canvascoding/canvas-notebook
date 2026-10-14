import 'server-only';
import { presentPersonalWorkflowProvider } from './workflow-provider-presentation';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import type { SqlConnection } from '@/app/lib/db';
import { createPersonalComposioAccountReference, readPersonalComposioAccountReference } from '@/app/lib/composio/composio-shared-account-reference';
import { IntegrationContractError, type IntegrationExecutionContext, type IntegrationProviderDescriptor, type IntegrationSourceSnapshot } from './contracts';
import type { IntegrationResolvedProvider } from './runtime-contracts';
import type { PersonalComposioProviderInspection } from './adapters/composio-runtime';
import { schemaFingerprint } from './schema';

const id = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const personalBindingSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('mcp'), ownerUserId: id, connectionId: z.string().uuid(), serverDefinitionId: z.string().uuid().nullable() }).strict(),
  z.object({ source: z.literal('composio'), ownerUserId: id, profileId: id, toolkit: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/u),
    mode: z.enum(['local', 'managed']), accountBinding: z.enum(['account', 'no_auth']), connectedAccountId: id.nullable() }).strict(),
]).superRefine((binding, context) => {
  if (binding.source === 'composio' && (binding.accountBinding === 'no_auth' ? binding.connectedAccountId !== null : binding.connectedAccountId === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An exact account binding is required.' });
  }
});
export type PersonalWorkflowProviderBinding = z.infer<typeof personalBindingSchema>;
export type PersonalWorkflowProviderTargetSnapshot = {
  binding: PersonalWorkflowProviderBinding;
  boundProviderRef: string;
  baseProviderRef: string;
  bindingFingerprint: string;
};
export type PreparedPersonalWorkflowProviderTarget = Readonly<{
  kind: 'prepared_personal_workflow_provider_target'; source: 'mcp' | 'composio'; boundProviderRef: string;
}>;
type PreparedRecord = {
  actor: Readonly<AgentManagementActor>;
  context: IntegrationExecutionContext;
  target: PersonalWorkflowProviderTargetSnapshot;
  resolved: IntegrationResolvedProvider;
  composio?: PersonalComposioProviderInspection;
  staticOnly?: boolean;
  expiresAt: number;
};
type ContextProof = { namespace: string; prepared: ReadonlyMap<string, PreparedPersonalWorkflowProviderTarget> };
const host = globalThis as typeof globalThis & { __canvasPersonalWorkflowProvidersV1?: {
  prepared: WeakMap<object, PreparedRecord>; contexts: WeakMap<object, ContextProof>;
} };
const proofs = host.__canvasPersonalWorkflowProvidersV1 ??= { prepared: new WeakMap(), contexts: new WeakMap() };
const boundPattern = /^(mcp|composio):v1:personal:[a-f0-9]{64}$/u;

function changed(): never { throw new IntegrationContractError('binding_changed', 'The personal workflow connection changed. Choose its current account again.'); }
function denied(): never { throw new IntegrationContractError('provider_denied', 'This personal workflow connection is unavailable to the current actor.'); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function namespace(context: IntegrationExecutionContext): string {
  return JSON.stringify([context.actorUserId, context.organizationId ?? null, context.workspaceId ?? null,
    context.agentId ?? null, context.sessionId ?? null, context.policyRevision]);
}
function boundRef(binding: PersonalWorkflowProviderBinding): string { return `${binding.source}:v1:personal:${hash(binding)}`; }

export function validatePersonalWorkflowProviderBinding(value: unknown): PersonalWorkflowProviderBinding {
  const parsed = personalBindingSchema.safeParse(value);
  if (!parsed.success) return denied();
  return freeze(parsed.data);
}
function snapshot(value: PersonalWorkflowProviderTargetSnapshot): PersonalWorkflowProviderTargetSnapshot {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['binding', 'baseProviderRef', 'boundProviderRef', 'bindingFingerprint'].includes(key))) return denied();
  const binding = validatePersonalWorkflowProviderBinding(value.binding);
  if (value.boundProviderRef !== boundRef(binding) || !boundPattern.test(value.boundProviderRef)
    || !value.baseProviderRef.startsWith(`${binding.source}:v1:`) || value.baseProviderRef.length > 256
    || value.baseProviderRef.includes(':personal:') || value.baseProviderRef.includes(':shared:')
    || !/^[a-f0-9]{64}$/u.test(value.bindingFingerprint)) return denied();
  return freeze({ binding, boundProviderRef: value.boundProviderRef, baseProviderRef: value.baseProviderRef, bindingFingerprint: value.bindingFingerprint });
}

async function withActor<T>(actor: AgentManagementActor, database: SqlConnection | undefined, lock: boolean,
  callback: (database: SqlConnection, context: IntegrationExecutionContext) => Promise<T>): Promise<T> {
  const connection = database ?? await (await import('@/app/lib/db')).openDb();
  try {
    const { resolveVerifiedAgentActorContextOnConnection } = await import('@/app/lib/agents/actor-context');
    const current = await resolveVerifiedAgentActorContextOnConnection(actor, connection, { lock });
    return await callback(connection, { actorUserId: current.userId, organizationId: current.organizationId,
      workspaceId: current.context.workspaceId ?? null, agentId: actor.sourceAgentId ?? null, sessionId: actor.sessionId ?? null,
      policyRevision: 'personal-workflow-configuration' });
  } finally { if (!database) await connection.close(); }
}
function issue(actor: AgentManagementActor, context: IntegrationExecutionContext, target: PersonalWorkflowProviderTargetSnapshot,
  resolved: IntegrationResolvedProvider, composio?: PersonalComposioProviderInspection, staticOnly = false): PreparedPersonalWorkflowProviderTarget {
  const proof = Object.freeze({ kind: 'prepared_personal_workflow_provider_target' as const, source: target.binding.source,
    boundProviderRef: target.boundProviderRef });
  proofs.prepared.set(proof, { actor: Object.freeze({ ...actor }), context: { ...context }, target: snapshot(target),
    resolved: { ...resolved, provider: { ...resolved.provider, providerRef: target.boundProviderRef },
      bindingRevision: schemaFingerprint([target.boundProviderRef, target.bindingFingerprint, resolved.bindingRevision]) }, composio, staticOnly,
    expiresAt: Date.now() + 5 * 60_000 });
  return proof;
}
function preparedRecord(proof: PreparedPersonalWorkflowProviderTarget): PreparedRecord {
  const record = proofs.prepared.get(proof);
  if (!record || record.expiresAt <= Date.now() || proof.kind !== 'prepared_personal_workflow_provider_target'
    || proof.boundProviderRef !== record.target.boundProviderRef || proof.source !== record.target.binding.source) return denied();
  return record;
}
export function isPreparedPersonalWorkflowProviderTarget(value: unknown): value is PreparedPersonalWorkflowProviderTarget {
  if (!value || typeof value !== 'object') return false;
  try { preparedRecord(value as PreparedPersonalWorkflowProviderTarget); return true; } catch { return false; }
}
export function getPreparedPersonalWorkflowProviderTarget(proof: PreparedPersonalWorkflowProviderTarget): PersonalWorkflowProviderTargetSnapshot {
  return freeze(structuredClone(preparedRecord(proof).target));
}
function composioTarget(inspection: PersonalComposioProviderInspection, accountId: string | null): PersonalWorkflowProviderTargetSnapshot {
  const binding: PersonalWorkflowProviderBinding = { source: 'composio', ownerUserId: inspection.executionContext.actorUserId,
    profileId: inspection.context.profileId, toolkit: inspection.provider.application!, mode: inspection.mode,
    accountBinding: inspection.noAuth ? 'no_auth' : 'account', connectedAccountId: accountId };
  return { binding, baseProviderRef: inspection.provider.providerRef, boundProviderRef: boundRef(binding),
    bindingFingerprint: hash([binding, inspection.context.composioUserId, inspection.credentialRevision, inspection.noAuth]) };
}

export async function listPersonalWorkflowProviderAccountChoices(input: { actor: AgentManagementActor; providerRef: string;
  exactToolkit?: { profileId: string; toolkit: string } }) {
  const actor = { ...input.actor }; const providerRef = input.providerRef;
  const context = await withActor(actor, undefined, false, async (_database, current) => current);
  const { inspectPersonalComposioIntegrationProvider, inspectOwnedPersonalComposioToolkit } = await import('./adapters/composio-runtime');
  const inspection = input.exactToolkit ? await inspectOwnedPersonalComposioToolkit(context, { ...input.exactToolkit, expectedProviderRef: providerRef })
    : await inspectPersonalComposioIntegrationProvider(context, providerRef);
  if (inspection.provider.providerRef !== providerRef) return denied();
  if (input.exactToolkit && inspection.accounts.length > 100) throw new IntegrationContractError('provider_unavailable', 'The selected app has too many accounts for this chooser.');
  if (input.exactToolkit) {
    const current = await withActor(actor, undefined, false, async (_database, value) => value);
    if (current.organizationId !== context.organizationId || current.workspaceId !== context.workspaceId) return changed();
    const { resolveBoundComposioContext } = await import('@/app/lib/composio/composio-context');
    const profile = await resolveBoundComposioContext({ userId: current.actorUserId, workspaceId: current.workspaceId,
      profileId: inspection.context.profileId });
    const { readPersonalComposioProviderCredentialRevision } = await import('./adapters/composio-runtime');
    if (profile.cacheRevision !== inspection.context.cacheRevision || profile.composioUserId !== inspection.context.composioUserId
      || await readPersonalComposioProviderCredentialRevision(inspection) !== inspection.credentialRevision) return changed();
  }
  const accounts = inspection.accounts.map((account, index) => {
    if (typeof account.id !== 'string' || !account.id.trim()) return denied();
    const label = typeof account.name === 'string' && account.name.trim() && account.name !== account.id
      ? account.name.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 100) : `Account ${index + 1}`;
    return { accountSelectionRef: createPersonalComposioAccountReference({ actorUserId: context.actorUserId,
      workspaceId: context.workspaceId ?? null, organizationId: context.organizationId ?? null,
      providerRef, profileId: inspection.context.profileId, cacheRevision: inspection.context.cacheRevision,
      toolkit: inspection.provider.application!, accountId: account.id, credentialRevision: inspection.credentialRevision }),
      label, status: typeof account.status === 'string' ? account.status : 'UNKNOWN',
      selectable: account.status === 'ACTIVE' && account.isDisabled !== true && account.is_disabled !== true };
  });
  return { providerRef, noAuth: inspection.noAuth, accounts };
}

/** Raw backend identity is resolved only from the actor's catalogue or a sealed, current selection. */
export async function preparePersonalWorkflowProviderTarget(input: { actor: AgentManagementActor; providerRef: string;
  accountSelectionRef?: string; toolkit?: string }): Promise<PreparedPersonalWorkflowProviderTarget> {
  const actor = { ...input.actor }; const providerRef = input.providerRef; const accountSelectionRef = input.accountSelectionRef;
  const context = await withActor(actor, undefined, false, async (_database, current) => current);
  if (providerRef.startsWith('mcp:v1:')) {
    if (accountSelectionRef !== undefined || input.toolkit !== undefined) return denied();
    const { inspectPersonalMcpIntegrationProvider } = await import('./adapters/mcp-runtime');
    const inspection = await inspectPersonalMcpIntegrationProvider(context, providerRef);
    const binding: PersonalWorkflowProviderBinding = { source: 'mcp', ownerUserId: context.actorUserId,
      connectionId: inspection.identity.connectionId, serverDefinitionId: inspection.identity.serverDefinitionId };
    return issue(actor, context, { binding, baseProviderRef: providerRef, boundProviderRef: boundRef(binding),
      bindingFingerprint: hash(inspection.identity.fingerprint) }, inspection.resolved);
  }
  if (!providerRef.startsWith('composio:v1:')) return denied();
  const { inspectPersonalComposioIntegrationProvider, inspectPermittedPersonalComposioProvider, resolvePersonalComposioInspection } = await import('./adapters/composio-runtime');
  const inspection = input.toolkit === undefined ? await inspectPersonalComposioIntegrationProvider(context, providerRef)
    : await inspectPermittedPersonalComposioProvider(context, providerRef, input.toolkit);
  const active = [...new Set(inspection.accounts.filter(account => account.status === 'ACTIVE'
    && account.isDisabled !== true && account.is_disabled !== true).map(account => typeof account.id === 'string' ? account.id : '').filter(Boolean))];
  let accountId: string | null = null;
  if (accountSelectionRef !== undefined) {
    const selection = readPersonalComposioAccountReference(accountSelectionRef);
    if (selection.actorUserId !== context.actorUserId || selection.workspaceId !== (context.workspaceId ?? null)
      || selection.organizationId !== (context.organizationId ?? null) || selection.providerRef !== providerRef
      || selection.profileId !== inspection.context.profileId || selection.cacheRevision !== inspection.context.cacheRevision
      || selection.toolkit !== inspection.provider.application || selection.credentialRevision !== inspection.credentialRevision
      || inspection.noAuth || !active.includes(selection.accountId)) return changed();
    accountId = selection.accountId;
  } else if (!inspection.noAuth) {
    if (active.length !== 1) throw new IntegrationContractError('binding_changed', 'Select one active account for this Composio app before saving its workflow binding.');
    accountId = active[0];
  }
  const target = composioTarget(inspection, accountId);
  return issue(actor, context, target, resolvePersonalComposioInspection(inspection, accountId), inspection);
}

/** Only called on a private target read from the actual workflow configuration by server code. */
export async function verifyStoredPersonalWorkflowProviderTarget(input: { actor: AgentManagementActor;
  target: PersonalWorkflowProviderTargetSnapshot }, options: { checkProviderReadiness?: boolean; database?: SqlConnection } = {}): Promise<PreparedPersonalWorkflowProviderTarget> {
  const actor = { ...input.actor }; const target = snapshot(input.target);
  if (options.database && options.checkProviderReadiness !== false) return denied();
  if (target.binding.ownerUserId !== actor.userId) return denied();
  const context = await withActor(actor, options.database, Boolean(options.database), async (_database, current) => current);
  if (options.checkProviderReadiness === false) {
    const { createIntegrationProviderRef } = await import('./references');
    let displayName: string;
    let metadataStamp: string;
    const { readUnifiedEnvState, assertUnifiedEnvReadable } = await import('@/app/lib/secrets/unified-env-store');
    const environment = await readUnifiedEnvState({ userId: actor.userId });
    assertUnifiedEnvReadable(environment);
    if (target.binding.source === 'composio') {
      const database = options.database ?? await (await import('@/app/lib/db')).openDb();
      try {
        const row = await database.get(`SELECT * FROM composio_connection_profiles WHERE id=$1${options.database ? ' FOR SHARE' : ''}`, [target.binding.profileId]) as Record<string, unknown> | undefined;
        if (!row || row.owner_user_id !== actor.userId || row.scope_type !== 'user' || row.status !== 'active') return denied();
        const base = createIntegrationProviderRef({ source: 'composio', profileId: target.binding.profileId, toolkit: target.binding.toolkit,
          scope: { type: 'user', resourceId: `profile:${target.binding.profileId}:${target.binding.toolkit}`, ownerUserId: actor.userId } });
        if (base !== target.baseProviderRef) return denied();
        const { getComposioMode, getLocalComposioApiKey } = await import('@/app/lib/composio/composio-client');
        const mode = await getComposioMode({ secretScope: 'user', userId: actor.userId });
        if (mode !== target.binding.mode) return changed();
        displayName = `${target.binding.toolkit} · ${typeof row.name === 'string' ? row.name : 'Personal connection'}`;
        metadataStamp = schemaFingerprint([row, mode, environment.revision,
          hash(await getLocalComposioApiKey({ secretScope: 'user', userId: actor.userId }) ?? ''), target]);
      } finally { if (!options.database) await database.close(); }
    } else {
      const binding = target.binding;
      const { resolveMcpConfigPath } = await import('@/app/lib/mcp/config');
      const { readExistingConfig } = await import('@/app/lib/mcp/read-only-config');
      const { assertPersonalMcpConnectionMetadataAccess } = await import('@/app/lib/mcp/access');
      const database = options.database ?? await (await import('@/app/lib/db')).openDb();
      try {
        const row = context.organizationId ? await database.get('SELECT role,status FROM organization_user_permissions WHERE organization_id=$1 AND user_id=$2', [context.organizationId, actor.userId]) as { role: string; status: string } | undefined
          : await database.get('SELECT role FROM "user" WHERE id=$1', [actor.userId]) as { role: string; status?: string } | undefined;
        if (!row || context.organizationId && (row.status !== 'active' || row.role === 'external')) return denied();
        const canManageDefinitions = row.role === 'owner' || row.role === 'admin';
        const scope = { userId: actor.userId, organizationId: context.organizationId };
        const matches = Object.entries((await readExistingConfig(resolveMcpConfigPath(scope))).mcpServers)
          .filter(([, item]) => item.connectionId === binding.connectionId && item.ownerUserId === actor.userId);
        const selected = matches[0], connection = selected?.[1];
        if (matches.length !== 1 || !connection || (connection.serverDefinitionId || null) !== binding.serverDefinitionId) return changed();
        await assertPersonalMcpConnectionMetadataAccess(connection, scope,
          { userId: actor.userId, organizationId: context.organizationId ?? null, canManageDefinitions }, { allowDisabled: true });
        const base = createIntegrationProviderRef({ source: 'mcp', connectionId: connection.connectionId!,
          scope: { type: 'user', resourceId: connection.connectionId!, ownerUserId: actor.userId } });
        if (base !== target.baseProviderRef) return denied();
        displayName = connection.displayName || selected[0];
        const { hashMcpAuthConfig } = await import('@/app/lib/mcp/connection-identity');
        const { readMcpOAuthLifecycle } = await import('@/app/lib/mcp/oauth-lifecycle');
        const { listMcpServerDefinitions } = await import('@/app/lib/mcp/server-definitions');
        const lifecycle = await readMcpOAuthLifecycle(binding.connectionId, { userId: binding.ownerUserId });
        const definition = binding.serverDefinitionId && connection.organizationId
          ? (await listMcpServerDefinitions(connection.organizationId)).find(item => item.id === binding.serverDefinitionId) : null;
        metadataStamp = schemaFingerprint([target, displayName, hashMcpAuthConfig(connection), connection.enabled !== false,
          connection.authVersion || 1, lifecycle.generation, environment.revision, definition?.enabled ?? null,
          definition?.revision ?? null, definition?.config ?? null, context]);
      } finally { if (!options.database) await database.close(); }
    }
    const provider = presentPersonalWorkflowProvider(target, displayName);
    const proof = issue(actor, context, target, { provider, bindingRevision: target.bindingFingerprint, binding: null }, undefined, true);
    metadataProofs.set(proof, metadataStamp);
    return proof;
  }
  if (target.binding.source === 'mcp') {
    const { inspectPersonalMcpIntegrationProvider } = await import('./adapters/mcp-runtime');
    const current = await inspectPersonalMcpIntegrationProvider(context, target.baseProviderRef);
    if (current.identity.connectionId !== target.binding.connectionId || current.identity.serverDefinitionId !== target.binding.serverDefinitionId
      || hash(current.identity.fingerprint) !== target.bindingFingerprint) return changed();
    return issue(actor, context, target, current.resolved);
  }
  const { inspectOwnedPersonalComposioToolkit, resolvePersonalComposioInspection } = await import('./adapters/composio-runtime');
  const current = await inspectOwnedPersonalComposioToolkit(context, { profileId: target.binding.profileId, toolkit: target.binding.toolkit,
    expectedProviderRef: target.baseProviderRef });
  const expected = composioTarget(current, target.binding.connectedAccountId);
  if (JSON.stringify(expected.binding) !== JSON.stringify(target.binding) || expected.bindingFingerprint !== target.bindingFingerprint) return changed();
  return issue(actor, context, target, resolvePersonalComposioInspection(current, target.binding.connectedAccountId), current);
}

const metadataHost = globalThis as typeof globalThis & { __canvasPersonalWorkflowMetadataProofsV1?: WeakMap<object, string> };
const metadataProofs = metadataHost.__canvasPersonalWorkflowMetadataProofsV1 ??= new WeakMap<object, string>();

/** Local admission freshness of the original genuine metadata proof; never execution authority. */
export async function revalidatePreparedPersonalWorkflowMetadataOnConnection(database: SqlConnection,
  proof: PreparedPersonalWorkflowProviderTarget): Promise<void> {
  const record = preparedRecord(proof), expected = metadataProofs.get(proof);
  if (!record.staticOnly || !expected) return denied();
  const current = await verifyStoredPersonalWorkflowProviderTarget({ actor: record.actor, target: record.target },
    { checkProviderReadiness: false, database });
  if (metadataProofs.get(current) !== expected) return changed();
}

/** No BEGIN, COMMIT, connection borrowing or provider requests occur when a caller supplies its transaction. */
export async function revalidatePreparedPersonalWorkflowProviderTarget(proof: PreparedPersonalWorkflowProviderTarget,
  options: { database?: SqlConnection } = {}): Promise<void> {
  const record = preparedRecord(proof);
  if (record.staticOnly) return denied();
  await withActor(record.actor, options.database, true, async (database, context) => {
    if (context.actorUserId !== record.context.actorUserId || context.organizationId !== record.context.organizationId
      || context.workspaceId !== record.context.workspaceId) return denied();
    const binding = record.target.binding;
    if (binding.source === 'composio') {
      const row = await database.get(`SELECT owner_user_id,scope_type,status,composio_user_id FROM composio_connection_profiles WHERE id=$1 FOR SHARE`, [binding.profileId]) as Record<string, unknown> | undefined;
      if (!row || row.owner_user_id !== binding.ownerUserId || row.scope_type !== 'user' || row.status !== 'active'
        || row.composio_user_id !== record.composio?.context.composioUserId) return changed();
      const { readPersonalComposioProviderCredentialRevision } = await import('./adapters/composio-runtime');
      if (!record.composio || await readPersonalComposioProviderCredentialRevision(record.composio) !== record.composio.credentialRevision) return changed();
      return;
    }
    const { readMcpConfig } = await import('@/app/lib/mcp/config');
    const { hashMcpAuthConfig } = await import('@/app/lib/mcp/connection-identity');
    const { readMcpOAuthLifecycle } = await import('@/app/lib/mcp/oauth-lifecycle');
    const { listMcpServerDefinitions, matchesMcpServerDefinition } = await import('@/app/lib/mcp/server-definitions');
    const { readUnifiedEnvState, assertUnifiedEnvReadable } = await import('@/app/lib/secrets/unified-env-store');
    const connection = Object.values((await readMcpConfig({ userId: binding.ownerUserId })).mcpServers)
      .find(item => item.connectionId === binding.connectionId && item.ownerUserId === binding.ownerUserId);
    if (!connection || connection.serverDefinitionId !== (binding.serverDefinitionId ?? undefined)
      || connection.organizationId && connection.organizationId !== context.organizationId) return changed();
    const definition = binding.serverDefinitionId && connection.organizationId
      ? (await listMcpServerDefinitions(connection.organizationId)).find(item => item.id === binding.serverDefinitionId) : null;
    if (binding.serverDefinitionId && (!definition?.enabled || !matchesMcpServerDefinition(connection, definition))) return changed();
    const lifecycle = await readMcpOAuthLifecycle(binding.connectionId, { userId: binding.ownerUserId });
    const environment = await readUnifiedEnvState({ userId: binding.ownerUserId });
    assertUnifiedEnvReadable(environment);
    const fingerprint = schemaFingerprint([binding.connectionId, binding.ownerUserId, connection.organizationId || null,
      hashMcpAuthConfig(connection), connection.enabled !== false, connection.authVersion || 1, lifecycle.generation,
      environment.revision, definition?.enabled ?? null, definition?.revision ?? null, definition?.config || null]);
    if (hash(fingerprint) !== record.target.bindingFingerprint) return changed();
  });
}

export function attachPersonalWorkflowProviderTargets(context: IntegrationExecutionContext,
  prepared: readonly PreparedPersonalWorkflowProviderTarget[]): void {
  if (!context.actorUserId.trim() || !context.policyRevision.trim() || !context.sessionId?.trim() || !context.agentId?.trim()) return denied();
  const entries = new Map<string, PreparedPersonalWorkflowProviderTarget>();
  for (const proof of prepared) {
    const record = preparedRecord(proof);
    if (record.actor.userId !== context.actorUserId || record.context.organizationId !== (context.organizationId ?? null)
      || record.context.workspaceId !== (context.workspaceId ?? null) || record.actor.sessionId !== context.sessionId
      || record.actor.sourceAgentId !== context.agentId) return denied();
    const previous = entries.get(record.target.boundProviderRef);
    if (previous && JSON.stringify(getPreparedPersonalWorkflowProviderTarget(previous)) !== JSON.stringify(record.target)) return denied();
    entries.set(record.target.boundProviderRef, proof);
  }
  proofs.contexts.set(context, { namespace: namespace(context), prepared: entries });
}

export function getAttachedPersonalWorkflowProviderTarget(context: IntegrationExecutionContext,
  boundProviderRef: string): PreparedPersonalWorkflowProviderTarget | null {
  const proof = proofs.contexts.get(context);
  if (!proof || proof.namespace !== namespace(context) || !boundPattern.test(boundProviderRef)) return null;
  const prepared = proof.prepared.get(boundProviderRef);
  return prepared && isPreparedPersonalWorkflowProviderTarget(prepared) ? prepared : null;
}
export function transferPersonalWorkflowProviderTargets(original: IntegrationExecutionContext, copied: IntegrationExecutionContext): void {
  const proof = proofs.contexts.get(original);
  if (proof && proof.namespace === namespace(original) && proof.namespace === namespace(copied)) proofs.contexts.set(copied, proof);
}

export async function resolveAttachedPersonalWorkflowProvider(context: IntegrationExecutionContext,
  providerRef: string): Promise<IntegrationResolvedProvider> {
  const prepared = getAttachedPersonalWorkflowProviderTarget(context, providerRef);
  if (!prepared) return denied();
  const previous = preparedRecord(prepared);
  const current = await verifyStoredPersonalWorkflowProviderTarget({ actor: previous.actor, target: previous.target });
  const record = preparedRecord(current);
  return record.resolved;
}

/** Context-bound workflow providers augment the catalogue; ordinary personal discovery keeps its existing shape. */
export function overlayPersonalWorkflowProviderCatalog(context: IntegrationExecutionContext, source: IntegrationSourceSnapshot): IntegrationSourceSnapshot {
  const proof = proofs.contexts.get(context);
  if (!proof || proof.namespace !== namespace(context)) return source;
  const providers: IntegrationProviderDescriptor[] = [];
  for (const prepared of proof.prepared.values()) {
    if (!isPreparedPersonalWorkflowProviderTarget(prepared) || prepared.source !== source.source) continue;
    const record = preparedRecord(prepared);
    const provider = record.resolved.provider;
    providers.push({ ...provider, nextActions: provider.nextActions.map(action => action.kind === 'gateway'
      && 'providerRef' in action.request ? { ...action, request: { ...action.request, providerRef: provider.providerRef } } : action) });
  }
  return { ...source, providers: [...source.providers, ...providers], revision: schemaFingerprint([source.revision,
    providers.map(provider => [provider.providerRef, preparedRecord(proof.prepared.get(provider.providerRef)!).target.bindingFingerprint])]) };
}
