import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqlConnection } from '@/app/lib/db';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  chatExtensionSelectionInputSchema,
  chatExtensionSelectionSchema,
  EXTENSION_SELECTION_LIMITS,
  type ChatExtensionSelection,
} from './contracts';
import {
  copyBoundedJson,
  freeze,
  parseStoredStandaloneExtensionBinding,
  storedStandaloneExtensionBindingSchema,
  type StoredStandaloneExtensionBinding,
} from './stored-contracts';
import {
  getPreparedStandaloneExtensionBinding,
  prepareStandaloneExtensionSelection,
  revalidatePreparedStandaloneExtensionSelection,
  withRevalidatedStandaloneTurnSelectionOnConnection,
  type PreparedStandaloneExtensionSelection,
} from './standalone-preparation';
import { withAuthorizedCorePluginSource } from './core-source';

type FixedBinding = Extract<StoredStandaloneExtensionBinding, { mode: 'fixed' }>;
const fixedBindingSchema = storedStandaloneExtensionBindingSchema.transform((binding, context): FixedBinding => {
  if (binding.mode !== 'fixed') {
    context.addIssue({ code: 'custom', message: 'Accepted turns contain exact fixed connections only.' });
    return z.NEVER;
  }
  return binding;
});
const durableSchema = z.object({
  version: z.literal(1),
  kind: z.literal('accepted_turn_extension_selection'),
  publicSelection: chatExtensionSelectionSchema,
  privateFixedBindings: z.array(fixedBindingSchema).max(EXTENSION_SELECTION_LIMITS.turn),
}).strict().superRefine((value, context) => {
  const standalone = value.publicSelection.selections.filter(entry => entry.selection.kind === 'mcp' || entry.selection.kind === 'composio');
  if (standalone.length !== value.privateFixedBindings.length) {
    context.addIssue({ code: 'custom', message: 'Every standalone identity requires exactly one private fixed binding.' });
    return;
  }
  standalone.forEach((entry, index) => {
    const bound = value.privateFixedBindings[index].entry;
    if (JSON.stringify(entry.selection) !== JSON.stringify(bound.selection) || entry.requirement !== bound.requirement
      || JSON.stringify(entry.toolCap) !== JSON.stringify(bound.toolCap)) {
      context.addIssue({ code: 'custom', message: 'The public identity, requirement and cap must match the private binding exactly.' });
    }
  });
});

/** Strict durable syntax only. Deserializing this DTO does not issue authority. */
export const storedAcceptedTurnExtensionSelectionSchema = z.preprocess((value, context) => {
  try {
    return copyBoundedJson(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'A bounded private JSON turn selection is required.' });
    return z.NEVER;
  }
}, durableSchema).transform(value => freeze(value));
export type StoredAcceptedTurnExtensionSelection = z.infer<typeof storedAcceptedTurnExtensionSelectionSchema>;

export type AcceptedTurnExtensionSelection = Readonly<{
  kind: 'accepted_turn_extension_selection';
  fingerprint: string;
}>;
type AcceptedRecord = {
  actorKey: string;
  publicNamespace: string;
  data: StoredAcceptedTurnExtensionSelection;
  prepared: readonly PreparedStandaloneExtensionSelection[];
};
const host = globalThis as typeof globalThis & {
  __canvasAcceptedTurnExtensionSelectionsV1?: WeakMap<object, AcceptedRecord>;
};
const records = host.__canvasAcceptedTurnExtensionSelectionsV1 ??= new WeakMap<object, AcceptedRecord>();

function actorKey(context: AgentExecutionContext): string {
  if (!context.userId?.trim() || !context.sessionId?.trim() || !context.workspaceId?.trim()) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'A current authenticated agent turn is required.', 403);
  }
  return JSON.stringify([context.userId, context.sessionId, context.agentTurnId ?? null, context.agentId,
    context.organizationId, context.workspaceId, context.workspaceType, context.workspaceRoot, context.workspaceRootRelativePath,
    context.projectId, context.customerId, context.canWrite, context.canDelete, context.canShare, context.legacy,
    context.turnExtensions ?? null]);
}

export function parseStoredAcceptedTurnExtensionSelection(value: unknown): StoredAcceptedTurnExtensionSelection {
  const parsed = storedAcceptedTurnExtensionSelectionSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentWorkflowError('AGENT_TURN_SELECTION_CORRUPT', 'The stored exact turn selection is invalid.', 409);
  }
  return parsed.data;
}

function selectedFixedBinding(proof: PreparedStandaloneExtensionSelection, actor: AgentManagementActor): FixedBinding {
  const binding = parseStoredStandaloneExtensionBinding(getPreparedStandaloneExtensionBinding(proof, actor));
  if (binding.mode !== 'fixed' || binding.entry.target.kind === 'personal' && binding.entry.target.ownerUserId !== actor.userId) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The selected connection does not match the current actor.', 403);
  }
  return binding;
}

/**
 * Consume short-lived intake receipts through the real current source services,
 * then issue receipt-free exact intent. This saves nothing and grants no tools.
 * Package pins and fixed-agent masks still require their runtime authorization.
 */
export async function prepareAcceptedTurnExtensionSelection(contextInput: AgentExecutionContext,
  value: unknown): Promise<AcceptedTurnExtensionSelection> {
  let input: z.infer<typeof chatExtensionSelectionInputSchema>;
  try {
    input = chatExtensionSelectionInputSchema.parse(copyBoundedJson(value));
  } catch {
    throw new AgentWorkflowError('AGENT_TURN_SELECTION_INVALID', 'A bounded exact turn selection is required.', 400);
  }
  const context = structuredClone(contextInput);
  const namespace = actorKey(context);
  const actor: AgentManagementActor = Object.freeze({ userId: context.userId, source: 'system', sourceAgentId: context.agentId,
    sessionId: context.sessionId, organizationId: context.organizationId, workspaceId: context.workspaceId, projectId: context.projectId });
  const prepared: PreparedStandaloneExtensionSelection[] = [];
  for (const entry of input.selections) {
    if (entry.selection.kind === 'mcp' || entry.selection.kind === 'composio') {
      prepared.push(await prepareStandaloneExtensionSelection(actor, entry));
    }
  }
  // Recheck the complete batch after preparation; an earlier source may have
  // changed while a later explicit account receipt was being consumed.
  for (const proof of prepared) await revalidatePreparedStandaloneExtensionSelection(proof, actor);
  for(const entry of input.selections) if(entry.selection.kind==='core_plugin') {
    if(entry.toolCap!==null) throw new AgentWorkflowError('AGENT_TURN_SELECTION_INVALID','Core instruction selections require a null tool capability field.',400);
    await withAuthorizedCorePluginSource(actor,entry.selection.coreSource,async()=>undefined);
  }
  if (actorKey(contextInput) !== namespace) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The agent turn changed during selection acceptance.', 403);
  }
  const publicSelection: ChatExtensionSelection = chatExtensionSelectionSchema.parse({ version: 1, origin: 'turn_reference',
    selections: input.selections.map(entry => ({ selection: entry.selection, requirement: entry.requirement, toolCap: entry.toolCap })),
    ...(input.packageConnections === undefined ? {} : { packageConnections: input.packageConnections }) });
  const data = parseStoredAcceptedTurnExtensionSelection({ version: 1, kind: 'accepted_turn_extension_selection', publicSelection,
    privateFixedBindings: prepared.map(proof => selectedFixedBinding(proof, actor)) });
  const publicNamespace = JSON.stringify(data.publicSelection);
  const fingerprint = createHash('sha256').update(JSON.stringify([namespace, publicNamespace, data.privateFixedBindings])).digest('hex');
  const handle = Object.freeze({ kind: 'accepted_turn_extension_selection' as const, fingerprint });
  records.set(handle, { actorKey: namespace, publicNamespace, data, prepared: Object.freeze([...prepared]) });
  return handle;
}

/**
 * Server-only accepted metadata, without expiry on the accepted identity itself.
 * Clones/foreign scopes fail. This does not revalidate or authorize execution.
 * Queue/history rehydration must independently verify the fresh actor, package
 * pins and exact stored source targets before issuing any new runtime proof;
 * never refresh an intake receipt or replace an account with a default choice.
 */
export function readAcceptedTurnExtensionSelection(handle: AcceptedTurnExtensionSelection,
  context: AgentExecutionContext): StoredAcceptedTurnExtensionSelection {
  const record = handle && typeof handle === 'object' ? records.get(handle) : undefined;
  if (!record || record.actorKey !== actorKey(context) || record.publicNamespace !== JSON.stringify(record.data.publicSelection)) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The accepted turn selection does not match this context.', 403);
  }
  return record.data;
}

/** Only actual intake provenance can cross the SQL admission boundary. Stored JSON cannot mint it. */
export async function withRevalidatedAcceptedTurnExtensionSelectionOnConnection<T>(database: SqlConnection,
  context: AgentExecutionContext, handle: AcceptedTurnExtensionSelection,
  callback: (selection: StoredAcceptedTurnExtensionSelection) => Promise<T>): Promise<T> {
  const { resolveVerifiedAgentActorContextOnConnection } = await import('@/app/lib/agents/actor-context');
  const { readStoredAgentWorkspaceOnConnection, workspaceToAgentExecutionContext } = await import('@/app/lib/pi/session-workspace-context');
  const data = readAcceptedTurnExtensionSelection(handle, context), record = records.get(handle)!;
  const transactionId = String((await database.get('SELECT txid_current()::text AS transaction_id') as { transaction_id?: string } | undefined)?.transaction_id ?? '');
  const actor: AgentManagementActor = Object.freeze({ userId: context.userId, source: 'system', sourceAgentId: context.agentId,
    sessionId: context.sessionId, organizationId: context.organizationId, workspaceId: context.workspaceId, projectId: context.projectId });
  const verifyActor = async () => {
    if (!context.agentId || !context.workspaceId) throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'A stored Agent session is required.', 403);
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database, { lock: true });
    const workspace = await readStoredAgentWorkspaceOnConnection(database, { userId: context.userId, sessionId: context.sessionId,
      agentId: context.agentId, workspaceId: context.workspaceId, permissions: ['canRead', 'canRunAgent'] });
    const fresh = { ...context, ...workspaceToAgentExecutionContext({ workspace, userId: context.userId,
      sessionId: context.sessionId, agentId: context.agentId }) };
    if (verified.organizationId !== context.organizationId || actorKey(fresh) !== record.actorKey) {
      throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The actual session or workspace changed before admission.', 403);
    }
    readAcceptedTurnExtensionSelection(handle, context);
    const currentTransaction = String((await database.get('SELECT txid_current()::text AS transaction_id') as { transaction_id?: string } | undefined)?.transaction_id ?? '');
    if (!transactionId || currentTransaction !== transactionId) {
      throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The actual admission transaction changed.', 403);
    }
  };
  await verifyActor();
  if (!Array.isArray(record.prepared) || record.prepared.length !== data.privateFixedBindings.length) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The actual prepared turn sources are unavailable.', 403);
  }
  // Every invocation acquires the complete stable source order before the Agent callback.
  const sourceOrder = (binding: FixedBinding) => binding.entry.target.kind === 'shared'
    ? `0:${binding.entry.target.connectionRef}` : `1:${JSON.stringify(binding.entry.selection)}`;
  const sources = record.prepared.map((proof, index) => ({ proof, binding: data.privateFixedBindings[index] }))
    .sort((left, right) => sourceOrder(left.binding).localeCompare(sourceOrder(right.binding)));
  const hold = async (index: number): Promise<T> => {
    readAcceptedTurnExtensionSelection(handle, context);
    if (index === sources.length) {
      const core=data.publicSelection.selections.filter(entry=>entry.selection.kind==='core_plugin');
      const holdCore=async(coreIndex:number):Promise<T>=>{
        const entry=core[coreIndex];
        if(!entry)return callback(data);
        if(entry.selection.kind!=='core_plugin') throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED','The Core source changed.',403);
        return withAuthorizedCorePluginSource(actor,entry.selection.coreSource,()=>holdCore(coreIndex+1),{database});
      };
      const result = await holdCore(0);
      await verifyActor();
      readAcceptedTurnExtensionSelection(handle, context);
      return result;
    }
    const { proof, binding } = sources[index];
    if (JSON.stringify(selectedFixedBinding(proof, actor)) !== JSON.stringify(binding)) {
      throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The actual prepared source no longer matches this turn.', 403);
    }
    return withRevalidatedStandaloneTurnSelectionOnConnection(database, proof, actor, () => hold(index + 1));
  };
  return hold(0);
}
