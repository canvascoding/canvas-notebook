import assert from 'node:assert/strict';
import { z } from 'zod';
import { agentExtensionConfigurationInputSchema } from '../../app/lib/capabilities/extensions/contracts';

const identifier = z.string().min(1).max(256), revision = z.number().int().positive();
const bindingSchema = z.object({ id: identifier, agentId: identifier, resourceType: z.enum(['skill', 'plugin', 'connection']),
  scopeType: z.enum(['system', 'organization', 'user']), resourceId: identifier, name: identifier, version: identifier,
  requirement: z.enum(['optional', 'required']), revision }).strict();

/** Only central persisted configuration. Personal readiness/choice presentation is intentionally separate. */
export const nativeCentralAgentSnapshotSchema = z.object({
  agent: z.object({ agentId: identifier, revision, workflowVersion: z.number().int().positive(), workflowRevision: revision }).passthrough(),
  bindings: z.array(bindingSchema),
  extensions: z.object({ agentId: identifier, revision, workflowRevision: revision, configurationState: z.literal('available'),
    configuration: agentExtensionConfigurationInputSchema.refine(value => value.mode === 'fixed') }).strict(),
}).strict().superRefine((value, context) => {
  if (value.agent.agentId !== value.extensions.agentId || value.agent.revision !== value.extensions.revision
    || value.agent.workflowRevision !== value.extensions.workflowRevision
    || value.bindings.some(binding => binding.agentId !== value.agent.agentId)
    || new Set(value.bindings.map(binding => binding.id)).size !== value.bindings.length) {
    context.addIssue({ code: 'custom', message: 'Central configuration identities and revisions must agree.' });
  }
});
export type NativeCentralAgentSnapshot = z.infer<typeof nativeCentralAgentSnapshotSchema>;

/** The same projection accepts the normal API data and the parent's independently inspected current state. */
export function projectNativeCentralAgentSnapshot(value: unknown): NativeCentralAgentSnapshot {
  const data = z.object({ agent: z.unknown(), bindings: z.unknown(), extensions: z.object({ agentId: z.unknown(), revision: z.unknown(),
    workflowRevision: z.unknown(), configurationState: z.unknown(), configuration: z.unknown() }).passthrough() }).passthrough().parse(value);
  const { agentId, revision: agentRevision, workflowRevision, configurationState, configuration } = data.extensions;
  return nativeCentralAgentSnapshotSchema.parse(structuredClone({ agent: data.agent, bindings: data.bindings,
    extensions: { agentId, revision: agentRevision, workflowRevision, configurationState, configuration } }));
}

/** Capture a real scoped GET response; envelope timestamps and personal preferences cannot enter the baseline. */
export function captureNativeCentralAgentSnapshot(value: unknown, expected: { agentId: string; workspaceId: string }): NativeCentralAgentSnapshot {
  const response = z.object({ success: z.literal(true), contractVersion: z.literal(2), workspaceId: identifier,
    checkedAt: z.number().int().nonnegative(), data: z.unknown() }).strict().parse(value);
  assert.equal(response.workspaceId, expected.workspaceId);
  const snapshot = projectNativeCentralAgentSnapshot(response.data);
  assert.equal(snapshot.agent.agentId, expected.agentId);
  return snapshot;
}

export function assertNativeCentralAgentUnchanged(before: unknown, after: unknown): void {
  assert.deepEqual(nativeCentralAgentSnapshotSchema.parse(after), nativeCentralAgentSnapshotSchema.parse(before),
    'Choosing a personal connection must preserve the complete central Agent profile, bindings, configuration and revisions.');
}
