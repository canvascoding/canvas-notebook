import type {
  AiResolvedRuntimeSelection,
  AiSessionRuntimeSnapshot,
} from '@/app/lib/agent-runtime-policy/types';

export function sessionRuntimeSnapshotFromResolvedSelection(
  selection: AiResolvedRuntimeSelection,
): AiSessionRuntimeSnapshot {
  return {
    selection: selection.selection,
    catalogRevision: selection.catalogRevision,
    policyRevision: selection.policyRevision,
    selectionSource: selection.selectionSource,
  };
}
