import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkspaceType } from '@/app/lib/workspaces/types';
import type { HeldCapabilityPackageRuntimeBinding } from '@/app/lib/capabilities/packages/runtime-bindings';
import type { HeldCorePluginSkillRuntimeBinding } from '@/app/lib/capabilities/packages/core-runtime-bindings';
import type { ChatExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { HeldEffectiveExtensionContext } from '@/app/lib/capabilities/extensions/effective-context';
import type { HeldAcceptedTurnRuntimeSelection } from '@/app/lib/capabilities/extensions/turn-runtime';
import type { HeldDelegatedExtensionSource } from '@/app/lib/capabilities/extensions/delegation-source';

export type AgentExecutionContext = {
  userId: string;
  sessionId: string;
  /** Server-issued identity for the user message currently driving this tool call. */
  agentTurnId?: string;
  agentId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceType;
  workspaceName: string | null;
  workspaceDescription?: string | null;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceRoot: string;
  workspaceRootRelativePath: string | null;
  skillReadRoots?: readonly string[];
  /** Private server-issued package receipts; serialized clones cannot authorize roots. */
  skillPackageBindings?: readonly HeldCapabilityPackageRuntimeBinding[];
  /** Actor-bound bundled Core dependency sources; never SQL publication identities. */
  corePluginSkillBindings?: readonly HeldCorePluginSkillRuntimeBinding[];
  /** Accepted receipt-free turn intent. Fresh resource checks and issued root proofs remain required. */
  turnExtensions?: ChatExtensionSelection;
  /** Actual issued current-turn source; private connection targets never enter this context. */
  turnExtensionSource?: HeldAcceptedTurnRuntimeSelection;
  /** Server-issued parent provenance; it only adds a fresh delegation ceiling. */
  delegatedExtensionSource?: HeldDelegatedExtensionSource;
  /** Opaque issued metadata handle; private snapshots/targets are never enumerable context fields. */
  effectiveExtensions?: HeldEffectiveExtensionContext;
  canWrite: boolean;
  canDelete: boolean;
  canShare: boolean;
  legacy: boolean;
  brandContext?: string;
};

const agentExecutionContextStorage = new AsyncLocalStorage<AgentExecutionContext>();

export function getAgentExecutionContext(): AgentExecutionContext | null {
  return agentExecutionContextStorage.getStore() ?? null;
}

export function runWithAgentExecutionContext<T>(
  context: AgentExecutionContext,
  callback: () => T,
): T {
  return agentExecutionContextStorage.run(context, callback);
}
