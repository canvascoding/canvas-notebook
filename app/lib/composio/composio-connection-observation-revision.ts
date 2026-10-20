import 'server-only';

const state = globalThis as typeof globalThis & { __canvasComposioConnectionObservationRevision?: number };

/** Presentation-cache generation only, never an account or execution authorization. */
export function getComposioConnectionObservationRevision(): number {
  return state.__canvasComposioConnectionObservationRevision ?? 0;
}

/** Existing connect/disconnect/callback/profile invalidation also withdraws
 * Chat observations, including in-flight observations from the old generation. */
export function invalidateComposioConnectionObservations(): void {
  state.__canvasComposioConnectionObservationRevision = getComposioConnectionObservationRevision() + 1;
}
