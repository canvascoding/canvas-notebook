/** Carries only a previously authorized persisted snapshot, never guest tokens. */
export class FileGuestCheckpointRequestError extends Error {
  constructor(readonly status: number, readonly payload: {
    success: false; code: string; error: string; documentId: string; lifecycleGeneration: number;
    documentSequence: number; checkpointSequence: number; stateVector: string; stateProof: string | null;
  }) {
    super(payload.error);
  }
}
