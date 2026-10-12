import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentManagementActor } from './management-actions';
import { AgentWorkflowError, parseStoredAgentWorkflowTarget, type AgentWorkflowInternalSnapshot,
  type AgentWorkflowTarget, type StoredAgentWorkflowTarget } from './workflow-contracts';

/** Exact central configuration slot; an own runtime preference is not a configuration slot. */
export type AgentWorkflowBindingSlot = {
  resourceRef: string;
  publishedRevisionRef: string;
  declarationPath: string;
  capabilityId: string;
  alternativeKey: string;
  choiceId?: string;
};
type RetainedTarget = Extract<AgentWorkflowTarget, { kind: 'retained' }>;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const reference = /^agent-workflow-retain:v1:[a-f0-9]{64}$/u;
function bounded(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function slotValid(slot: AgentWorkflowBindingSlot): boolean {
  return Boolean(slot && typeof slot === 'object' && !Array.isArray(slot)
    && Object.keys(slot).every(key => ['resourceRef', 'publishedRevisionRef', 'declarationPath', 'capabilityId', 'alternativeKey', 'choiceId'].includes(key))
    && new RegExp(`^canvas-resource:${uuid}$`, 'u').test(slot.resourceRef)
    && new RegExp(`^canvas-package-revision:${uuid}$`, 'u').test(slot.publishedRevisionRef)
    && bounded(slot.declarationPath, 1_024) && !/^[A-Za-z]:|[\\]/u.test(slot.declarationPath)
    && slot.declarationPath.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
    && bounded(slot.capabilityId) && bounded(slot.alternativeKey)
    && (slot.choiceId === undefined || bounded(slot.choiceId)));
}
function oldTarget(actor: AgentManagementActor, snapshot: AgentWorkflowInternalSnapshot, slot: AgentWorkflowBindingSlot):
  { target: StoredAgentWorkflowTarget; checksum: string } | null {
  if (!slotValid(slot) || !bounded(actor.userId) || [actor.organizationId, actor.workspaceId, actor.projectId]
    .some(value => value != null && !bounded(value)) || snapshot.workflowVersion !== 1
    || !Number.isSafeInteger(snapshot.agent.revision) || snapshot.agent.revision < 1
    || !Number.isSafeInteger(snapshot.workflowRevision) || snapshot.workflowRevision < 1) return null;
  const packages = snapshot.bindings.flatMap(binding => binding.configuration && binding.configuration.resourceRef === slot.resourceRef
    && binding.configuration.publishedRevisionRef === slot.publishedRevisionRef ? [binding.configuration] : []);
  if (packages.length !== 1) return null;
  const pkg = packages[0], declarations = pkg.declarations.filter(entry => entry.declarationPath === slot.declarationPath);
  if (declarations.length !== 1) return null;
  const capabilities = declarations[0].capabilities.filter(entry => entry.capabilityId === slot.capabilityId);
  if (capabilities.length !== 1) return null;
  const selection = capabilities[0].selection;
  const choices = selection.mode === 'fixed' ? slot.choiceId === undefined ? [selection] : []
    : selection.allowedChoices.filter(choice => slot.choiceId !== undefined && choice.choiceId === slot.choiceId);
  if (choices.length !== 1 || choices[0].alternativeKey !== slot.alternativeKey) return null;
  const target = choices[0].target;
  if (target.kind === 'personal' ? target.ownerUserId !== actor.userId
    : target.source !== 'mcp' || !target.verifiedMcpMapping) return null;
  // Validate the durable codec, while returning an unchanged clone of the original stored value.
  parseStoredAgentWorkflowTarget(target);
  return { target: structuredClone(target), checksum: pkg.checksum };
}
function retentionRef(actor: AgentManagementActor, snapshot: AgentWorkflowInternalSnapshot, slot: AgentWorkflowBindingSlot,
  current: { target: StoredAgentWorkflowTarget; checksum: string }): string {
  const identity = [1, actor.userId, actor.organizationId ?? null, actor.workspaceId ?? null, actor.projectId ?? null,
    snapshot.agent.agentId, snapshot.agent.revision, snapshot.workflowRevision, slot.resourceRef, slot.publishedRevisionRef,
    current.checksum, slot.declarationPath, slot.capabilityId, slot.alternativeKey, slot.choiceId ?? null,
    parseStoredAgentWorkflowTarget(current.target)];
  return `agent-workflow-retain:v1:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

/** Only pass a freshly verified canonical actor and actual server-owned configuration snapshot.
 * The opaque reference is an identity hint, never authority to use or configure an account. */
export function createRetainedAgentWorkflowTarget(actor: AgentManagementActor, snapshot: AgentWorkflowInternalSnapshot,
  slot: AgentWorkflowBindingSlot): RetainedTarget | null {
  const current = oldTarget(actor, snapshot, slot);
  return current ? { kind: 'retained', retainedBindingRef: retentionRef(actor, snapshot, slot, current) } : null;
}

/** Resolve against the writer's fresh BEFORE snapshot; current provider authority is checked separately. */
export function resolveRetainedAgentWorkflowTarget(actor: AgentManagementActor, before: AgentWorkflowInternalSnapshot,
  slot: AgentWorkflowBindingSlot, ref: string): StoredAgentWorkflowTarget {
  const current = oldTarget(actor, before, slot);
  if (!current || !reference.test(ref) || !timingSafeEqual(Buffer.from(ref), Buffer.from(retentionRef(actor, before, slot, current)))) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_RETENTION_INVALID', 'The existing binding changed. Reload the configuration or select a connection explicitly.', 409);
  }
  return current.target;
}
