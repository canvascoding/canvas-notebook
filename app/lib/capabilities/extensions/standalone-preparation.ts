import 'server-only';

import { createHash } from 'node:crypto';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { IntegrationContractError } from '@/app/lib/integration-tools/contracts';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import {
  authorizeIntegrationConnection,
  revalidateAuthorizedIntegrationConnection,
  withRevalidatedIntegrationConnectionUseOnConnection,
} from '@/app/lib/integration-tools/connections/store';
import {
  getPreparedPersonalWorkflowProviderTarget,
  preparePersonalWorkflowProviderTarget,
  revalidatePreparedPersonalWorkflowProviderTarget,
} from '@/app/lib/integration-tools/workflow-personal-bindings';
import {
  extensionSelectionIdentity,
  standaloneExtensionInputSchema,
  type StandaloneExtensionInput,
} from './contracts';
import {
  parseStoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionBinding,
  type StoredStandaloneExtensionTarget,
} from './stored-contracts';

export type PreparedStandaloneExtensionSelection = Readonly<{
  kind: 'prepared_standalone_extension';
  source: 'mcp' | 'composio';
}>;
type PersonalProof = Awaited<ReturnType<typeof preparePersonalWorkflowProviderTarget>>;
type SharedProof = Awaited<ReturnType<typeof authorizeIntegrationConnection>>;
type PreparedRecord = {
  actorKey: string;
  verifiedActorKey: string;
  binding: StoredStandaloneExtensionBinding;
  personal?: PersonalProof;
  shared?: SharedProof;
  expiresAt: number;
};
const host = globalThis as typeof globalThis & {
  __canvasStandaloneExtensionPreparationV1?: WeakMap<object, PreparedRecord>;
};
const proofs = host.__canvasStandaloneExtensionPreparationV1 ??= new WeakMap<object, PreparedRecord>();

function actorKey(actor: AgentManagementActor): string {
  if (!actor.userId?.trim()) throw new IntegrationContractError('provider_denied', 'An authenticated actor is required.');
  return JSON.stringify([actor.userId, actor.organizationId ?? null, actor.workspaceId ?? null,
    actor.projectId ?? null, actor.sourceAgentId ?? null, actor.sessionId ?? null]);
}

/** Verify project-only and workspace/project relations through the same current SQL authority as agent actions. */
async function verifiedActor(actor: AgentManagementActor, database?: SqlConnection): Promise<AgentManagementActor> {
  const connection = database ?? await openDb();
  try {
    const current = await resolveVerifiedAgentActorContextOnConnection(actor, connection);
    return Object.freeze({ userId: current.userId, sessionId: actor.sessionId, source: actor.source,
      sourceAgentId: actor.sourceAgentId, organizationId: current.organizationId,
      workspaceId: current.context.workspaceId ?? null, projectId: current.context.projectId ?? null });
  } finally { if (!database) await connection.close(); }
}

function recordFor(proof: PreparedStandaloneExtensionSelection, actor: AgentManagementActor): PreparedRecord {
  const record = proof && typeof proof === 'object' ? proofs.get(proof) : undefined;
  if (!record || record.actorKey !== actorKey(actor) || record.expiresAt <= Date.now()) {
    throw new IntegrationContractError('provider_denied', 'A current server-issued extension selection is required.');
  }
  return record;
}

function fixedBinding(input: StandaloneExtensionInput, target: StoredStandaloneExtensionTarget): StoredStandaloneExtensionBinding {
  const configurationId = `fixed:${createHash('sha256').update(extensionSelectionIdentity(input.selection)).digest('base64url')}`;
  return parseStoredStandaloneExtensionBinding({ version: 1, kind: 'standalone', configurationId, mode: 'fixed',
    entry: { selection: input.selection, requirement: input.requirement, toolCap: input.toolCap, target } });
}

/**
 * Consume one explicit choice through the existing fresh provider authority.
 * This neither installs a package, grants access, saves a configuration nor
 * executes provider tools. Package requirements and prospective agent access
 * remain the responsibility of the calling configuration/chat action.
 */
export async function prepareStandaloneExtensionSelection(actorInput: AgentManagementActor,
  value: unknown): Promise<PreparedStandaloneExtensionSelection> {
  const parsed = standaloneExtensionInputSchema.safeParse(value);
  if (!parsed.success) throw new IntegrationContractError('invalid_request', 'An exact standalone extension selection is required.');
  const input = parsed.data, capturedActor = structuredClone(actorInput), namespace = actorKey(capturedActor);
  const actor = await verifiedActor(capturedActor);
  const selection = input.selection;
  let personal: PersonalProof | undefined, shared: SharedProof | undefined;
  let target: StoredStandaloneExtensionTarget;
  if (selection.target.kind === 'shared') {
    shared = await authorizeIntegrationConnection({ userId: actor.userId, organizationId: actor.organizationId,
      workspaceId: actor.workspaceId, agentId: actor.sourceAgentId, sessionId: actor.sessionId,
      policyRevision: 'standalone-extension-selection' }, selection.target.connectionRef, 'use');
    if (!shared.access.canUse || shared.resource.status !== 'active'
      || shared.resource.source !== selection.source
      || shared.resource.bindingRevision !== selection.target.bindingRevision
      || selection.kind === 'composio' && (shared.backend.source !== 'composio'
        || shared.backend.toolkit !== selection.toolkit || shared.backend.accountBinding === 'pending')) {
      throw new IntegrationContractError('binding_changed', 'The selected shared connection changed or needs setup.');
    }
    target = { kind: 'shared', source: selection.source, connectionRef: shared.resource.connectionRef,
      bindingRevision: shared.resource.bindingRevision };
  } else {
    const providerRef = selection.kind === 'mcp'
      ? createIntegrationProviderRef({ source: 'mcp', connectionId: selection.target.connectionRef.slice('mcp-personal:'.length),
        scope: { type: 'user', ownerUserId: actor.userId, resourceId: selection.target.connectionRef.slice('mcp-personal:'.length) } })
      : createIntegrationProviderRef({ source: 'composio', profileId: selection.target.profileId, toolkit: selection.toolkit,
        scope: { type: 'user', ownerUserId: actor.userId, resourceId: `profile:${selection.target.profileId}:${selection.toolkit}` } });
    personal = await preparePersonalWorkflowProviderTarget({ actor, providerRef,
      ...(selection.kind === 'composio' ? { toolkit: selection.toolkit, accountSelectionRef: input.accountSelectionRef } : {}) });
    const snapshot = getPreparedPersonalWorkflowProviderTarget(personal);
    target = { kind: 'personal', source: snapshot.binding.source, ownerUserId: snapshot.binding.ownerUserId,
      providerRef: snapshot.baseProviderRef, boundProviderRef: snapshot.boundProviderRef,
      bindingFingerprint: snapshot.bindingFingerprint, personalBinding: snapshot.binding };
  }
  // The private codec compares the chosen UUID/profile/toolkit/account/no_auth
  // against materialized authority. A changed single account is never a fallback.
  const binding = fixedBinding(input, target);
  if (shared) await revalidateAuthorizedIntegrationConnection(shared, 'use');
  if (personal) await revalidatePreparedPersonalWorkflowProviderTarget(personal);
  if (actorKey(await verifiedActor(capturedActor)) !== actorKey(actor)) {
    throw new IntegrationContractError('provider_denied', 'The current extension selection context changed.');
  }
  const proof = Object.freeze({ kind: 'prepared_standalone_extension' as const, source: selection.source });
  proofs.set(proof, { actorKey: namespace, verifiedActorKey: actorKey(actor), binding, personal, shared,
    expiresAt: Date.now() + 5 * 60_000 });
  return proof;
}

/** Cloneable private data is not execution authority. Revalidation remains required at the write/use boundary. */
export function getPreparedStandaloneExtensionBinding(proof: PreparedStandaloneExtensionSelection,
  actor: AgentManagementActor): StoredStandaloneExtensionBinding {
  return recordFor(proof, actor).binding;
}

/** Personal revalidation can participate in the caller's actual SQL transaction.
 * Shared writes require locked connection authority for the actual target agent;
 * the out-of-transaction read check must never be mistaken for that authority. */
export async function revalidatePreparedStandaloneExtensionSelection(proof: PreparedStandaloneExtensionSelection,
  actor: AgentManagementActor, options: { database?: SqlConnection } = {}): Promise<StoredStandaloneExtensionBinding> {
  const record = recordFor(proof, actor);
  if (record.shared && options.database) {
    throw new IntegrationContractError('invalid_request', 'Shared connection writes require locked target-agent authorization.');
  }
  const currentActor = await verifiedActor(structuredClone(actor), options.database);
  if (actorKey(currentActor) !== record.verifiedActorKey) {
    throw new IntegrationContractError('provider_denied', 'The current extension selection context changed.');
  }
  if (record.personal) await revalidatePreparedPersonalWorkflowProviderTarget(record.personal, options);
  if (record.shared) await revalidateAuthorizedIntegrationConnection(record.shared, 'use');
  recordFor(proof, actor);
  return record.binding;
}

/** Admission of exact turn intent uses current ActorUse, never target-Agent configuration authority. */
export async function withRevalidatedStandaloneTurnSelectionOnConnection<T>(database: SqlConnection,
  proof: PreparedStandaloneExtensionSelection, actor: AgentManagementActor, callback: () => Promise<T>): Promise<T> {
  const record = recordFor(proof, actor);
  const verify = async () => {
    const current = await verifiedActor(structuredClone(actor), database);
    if (actorKey(current) !== record.verifiedActorKey) {
      throw new IntegrationContractError('provider_denied', 'The current extension selection context changed.');
    }
    if (record.personal) await revalidatePreparedPersonalWorkflowProviderTarget(record.personal, { database });
    recordFor(proof, actor);
  };
  await verify();
  const run = async () => {
    const result = await callback();
    await verify();
    return result;
  };
  return record.shared ? withRevalidatedIntegrationConnectionUseOnConnection(database, record.shared, run) : run();
}
