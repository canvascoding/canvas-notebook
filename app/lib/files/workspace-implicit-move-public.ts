/** Explicit new unpublished implicit-Move wire arms. No native evidence is public. */
export type WorkspaceImplicitMoveIdentityPublic = Readonly<{
  actorUserId: string; workspaceId: string; operationId: string; requestId: string; selectionDigest: string;
}>;
export type WorkspaceImplicitMoveBindingPublic = WorkspaceImplicitMoveIdentityPublic & Readonly<{
  version: 1; kind: 'implicit-move-binding';
}>;
export type WorkspaceImplicitMoveSelectionPublic = WorkspaceImplicitMoveIdentityPublic & Readonly<{
  action: 'move' | 'rename'; selections: readonly Readonly<{ sourcePath: string; destinationPath: string }>[];
}>;
export type WorkspaceImplicitMovePreparationPublicV2 = WorkspaceImplicitMoveSelectionPublic & Readonly<{
  version: 2; kind: 'implicit-move-preparation';
}> & (Readonly<{ state: 'pending'; status: 'reserved' | 'draining' | 'recovery_required'; canResume: boolean; statusUrl: string; resumeUrl: string }>
  | Readonly<{ state: 'aborted'; reason: 'user_cancelled' | 'precondition_failed' }>);

/** Explicit original null-plan legacy replay; never substitutes a preparation binding. */
export type WorkspaceImplicitMoveLegacyReplayPublic = Readonly<{
  version: 1; kind: 'implicit-move-legacy-replay'; actorUserId: string; workspaceId: string;
  operationId: string; batchId: string; planId: string;
}>;
