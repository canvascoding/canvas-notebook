export const EXCALIDRAW_COLLABORATION_SCHEMA_VERSION = 1;
export const EXCALIDRAW_COLLABORATION_PATH = '/ws/collaboration/excalidraw';
export const EXCALIDRAW_MAX_MESSAGE_BYTES = 1024 * 1024;
export const EXCALIDRAW_MAX_PATCH_ELEMENTS = 2_000;
export const EXCALIDRAW_MAX_SCENE_ELEMENTS = 50_000;
export const EXCALIDRAW_FULL_SYNC_INTERVAL_MS = 20_000;
export const EXCALIDRAW_PATCH_COALESCE_MS = 40;
export const EXCALIDRAW_PRESENCE_THROTTLE_MS = 33;

export type ExcalidrawElementRecord = Record<string, unknown> & {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index?: string | null;
};

export type ExcalidrawSharedAppState = {
  viewBackgroundColor?: string;
  gridSize?: number | null;
  gridStep?: number;
  gridModeEnabled?: boolean;
};

export type ExcalidrawAssetMetadata = {
  fileId: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  createdAt: number;
};

export type ExcalidrawPresencePayload = {
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
  button?: 'up' | 'down';
  selectedElementIds?: Record<string, true>;
  idleState?: 'active' | 'idle' | 'away';
};

export type ExcalidrawSceneSnapshot = {
  elements: ExcalidrawElementRecord[];
  appState: ExcalidrawSharedAppState;
  assets: ExcalidrawAssetMetadata[];
  sceneSequence: number;
  lifecycleGeneration: number;
  canonicalHash: string;
};

export type ExcalidrawClientEnvelope = {
  schemaVersion: typeof EXCALIDRAW_COLLABORATION_SCHEMA_VERSION;
  type:
    | 'scene:patch'
    | 'scene:ack'
    | 'scene:resync_request'
    | 'presence:pointer'
    | 'presence:selection'
    | 'presence:idle';
  messageId: string;
  lifecycleGeneration: number;
  baseSequence: number;
  payload: unknown;
};

export type ExcalidrawServerMessage =
  | {
      schemaVersion: 1;
      type: 'scene:init';
      messageId: string;
      snapshot: ExcalidrawSceneSnapshot;
      permission: 'read' | 'write';
    }
  | {
      schemaVersion: 1;
      type: 'scene:applied';
      messageId: string;
      replyTo: string;
      elements: ExcalidrawElementRecord[];
      appState: ExcalidrawSharedAppState;
      assets: ExcalidrawAssetMetadata[];
      sceneSequence: number;
      canonicalHash: string;
      persisted: true;
      checkpointed: boolean;
    }
  | {
      schemaVersion: 1;
      type: 'scene:ack';
      messageId: string;
      replyTo: string;
      sceneSequence: number;
    }
  | {
      schemaVersion: 1;
      type: 'scene:resync_required';
      messageId: string;
      reason: string;
      sceneSequence: number;
    }
  | {
      schemaVersion: 1;
      type: 'scene:status';
      messageId: string;
      status: 'persisting' | 'saved' | 'degraded';
      sceneSequence: number;
      message?: string;
    }
  | {
      schemaVersion: 1;
      type: 'presence:update' | 'presence:leave';
      messageId: string;
      connectionId: string;
      user: { id: string; name: string; color: string; colorLight: string };
      payload?: ExcalidrawPresencePayload;
    }
  | {
      schemaVersion: 1;
      type: 'asset:available';
      messageId: string;
      asset: ExcalidrawAssetMetadata;
    }
  | {
      schemaVersion: 1;
      type: 'error';
      messageId: string;
      replyTo?: string;
      code: string;
      message: string;
    };

export function isExcalidrawClientEnvelope(value: unknown): value is ExcalidrawClientEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<ExcalidrawClientEnvelope>;
  return message.schemaVersion === EXCALIDRAW_COLLABORATION_SCHEMA_VERSION
    && typeof message.type === 'string'
    && [
      'scene:patch',
      'scene:ack',
      'scene:resync_request',
      'presence:pointer',
      'presence:selection',
      'presence:idle',
    ].includes(message.type)
    && typeof message.messageId === 'string'
    && message.messageId.length >= 8
    && message.messageId.length <= 128
    && Number.isSafeInteger(message.lifecycleGeneration)
    && Number(message.lifecycleGeneration) > 0
    && Number.isSafeInteger(message.baseSequence)
    && Number(message.baseSequence) >= 0;
}
