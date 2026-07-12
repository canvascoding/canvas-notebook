import 'server-only';

import {
  assertEffectiveRuntimeSelection,
  resolveEffectiveAgentRuntime,
  type AiRuntimeResolutionContext,
} from '@/app/lib/agent-runtime-policy/runtime-resolver';
import {
  AiRuntimeInputError,
  RuntimeContextRevisionConflictError,
  parseRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/runtime-service';
import {
  readPiSessionRuntimeSnapshot,
  writePiSessionRuntimeSnapshot,
} from '@/app/lib/agent-runtime-policy/runtime-store';
import type {
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiSessionRuntimeSnapshot,
} from '@/app/lib/agent-runtime-policy/types';

export type AiSessionRuntimeUpdate = {
  selection: AiRuntimeSelection;
  expectedCatalogRevision: number;
  expectedPolicyRevision: number;
};

function nonNegativeRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', `${field} must be a non-negative integer.`);
  }
  return value;
}

export function hasSessionRuntimeUpdate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.runtimeSelection !== undefined
    || record.expectedCatalogRevision !== undefined
    || record.expectedPolicyRevision !== undefined;
}

export function parseSessionRuntimeUpdate(value: unknown): AiSessionRuntimeUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'Session runtime update must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.runtimeSelection === undefined) {
    throw new AiRuntimeInputError('RUNTIME_SELECTION_REQUIRED', 'runtimeSelection is required.');
  }
  return {
    selection: parseRuntimeSelection(record.runtimeSelection),
    expectedCatalogRevision: nonNegativeRevision(record.expectedCatalogRevision, 'expectedCatalogRevision'),
    expectedPolicyRevision: nonNegativeRevision(record.expectedPolicyRevision, 'expectedPolicyRevision'),
  };
}

function assertExpectedContextRevisions(
  resolution: AiEffectiveRuntimeResolution,
  update: AiSessionRuntimeUpdate,
): void {
  if (
    resolution.catalogRevision !== update.expectedCatalogRevision
    || resolution.policyRevision !== update.expectedPolicyRevision
  ) {
    throw new RuntimeContextRevisionConflictError(
      resolution.catalogRevision,
      resolution.policyRevision,
    );
  }
}

function snapshotFromResolution(resolution: AiEffectiveRuntimeResolution): AiSessionRuntimeSnapshot {
  const selection = assertEffectiveRuntimeSelection(resolution);
  return {
    selection: selection.selection,
    catalogRevision: selection.catalogRevision,
    policyRevision: selection.policyRevision,
    selectionSource: selection.selectionSource,
  };
}

export async function prepareSessionRuntimeSnapshot(input: {
  context: AiRuntimeResolutionContext;
  update?: AiSessionRuntimeUpdate | null;
}): Promise<{
  resolution: AiEffectiveRuntimeResolution;
  snapshot: AiSessionRuntimeSnapshot;
}> {
  const resolution = await resolveEffectiveAgentRuntime({
    ...input.context,
    requestedSelection: input.update?.selection ?? null,
  });
  if (input.update) assertExpectedContextRevisions(resolution, input.update);
  return { resolution, snapshot: snapshotFromResolution(resolution) };
}

export async function replaceSessionRuntimeSnapshot(input: {
  context: AiRuntimeResolutionContext & { sessionId: string };
  update: AiSessionRuntimeUpdate;
}): Promise<{
  resolution: AiEffectiveRuntimeResolution;
  snapshot: AiSessionRuntimeSnapshot;
}> {
  const expectedSnapshot = await readPiSessionRuntimeSnapshot({
    sessionId: input.context.sessionId,
    userId: input.context.userId,
    agentId: input.context.agentId,
  });
  const prepared = await prepareSessionRuntimeSnapshot(input);

  await writePiSessionRuntimeSnapshot({
    sessionId: input.context.sessionId,
    userId: input.context.userId,
    agentId: input.context.agentId,
    snapshot: prepared.snapshot,
    expectedSnapshot,
    allowReplace: true,
    contextRevision: {
      organizationId: input.context.organizationId,
      workspaceId: input.context.workspaceId,
      expectedCatalogRevision: prepared.snapshot.catalogRevision,
      expectedPolicyRevision: prepared.snapshot.policyRevision,
    },
  });

  return {
    snapshot: prepared.snapshot,
    resolution: await resolveEffectiveAgentRuntime({
      ...input.context,
      requestedSelection: null,
    }),
  };
}
