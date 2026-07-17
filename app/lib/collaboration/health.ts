export interface CollaborationRuntimeHealth {
  websocketReady: boolean;
  persistenceReady: boolean;
  excalidrawWebsocketReady: boolean;
  scenePersistenceReady: boolean;
  assetStoreReady: boolean;
  capabilityReady: boolean;
  updatedAt: number | null;
}

const globalHealth = globalThis as typeof globalThis & { __canvasCollaborationHealth?: CollaborationRuntimeHealth };
const health = globalHealth.__canvasCollaborationHealth ??= {
  websocketReady: false,
  persistenceReady: false,
  excalidrawWebsocketReady: false,
  scenePersistenceReady: false,
  assetStoreReady: false,
  capabilityReady: false,
  updatedAt: null,
};

export function setCollaborationRuntimeHealth(next: Partial<CollaborationRuntimeHealth>): void {
  Object.assign(health, next, { updatedAt: Date.now() });
}

export function getCollaborationRuntimeHealth(): CollaborationRuntimeHealth {
  return { ...health };
}
