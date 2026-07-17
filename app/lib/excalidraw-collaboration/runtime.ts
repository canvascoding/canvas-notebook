import 'server-only';

import type { AppliedExcalidrawPatch } from './repository';

type RuntimeBridge = {
  connectionCount: (documentId: string) => number;
  publishApplied: (
    documentId: string,
    operationId: string,
    result: AppliedExcalidrawPatch,
    attribution: { actorId: string; initiatedByUserId: string },
  ) => void;
};

let bridge: RuntimeBridge | null = null;

export function installExcalidrawCollaborationRuntime(next: RuntimeBridge): () => void {
  bridge = next;
  return () => { if (bridge === next) bridge = null; };
}

export function getExcalidrawConnectionCount(documentId: string): number {
  return bridge?.connectionCount(documentId) ?? 0;
}

export function publishExcalidrawAgentPatch(
  documentId: string,
  operationId: string,
  result: AppliedExcalidrawPatch,
  attribution: { actorId: string; initiatedByUserId: string },
): void {
  bridge?.publishApplied(documentId, operationId, result, attribution);
}
