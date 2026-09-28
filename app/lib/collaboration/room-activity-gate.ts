export type CollaborationRoomActivityErrorCode =
  | 'ROOM_ACTIVITY_DRAINING'
  | 'ROOM_ACTIVITY_BUSY'
  | 'ROOM_ACTIVITY_CLOSED';

export class CollaborationRoomActivityError extends Error {
  constructor(readonly code: CollaborationRoomActivityErrorCode) {
    super(code === 'ROOM_ACTIVITY_DRAINING'
      ? 'Collaboration room activity is draining.'
      : code === 'ROOM_ACTIVITY_BUSY'
        ? 'Collaboration room activity capacity is exhausted.'
        : 'Collaboration room activity gate is closed.');
    this.name = 'CollaborationRoomActivityError';
  }
}

export type CollaborationRoomActivityLease = {
  release(): void;
  assertOpen(): void;
};

export type CollaborationRoomDrain = {
  idle: Promise<void>;
  finish(): void;
};

type ActivityRecord = {
  active: number;
  drain?: {
    idle: Promise<void>;
    resolveIdle: () => void;
    finished: boolean;
  };
};

export type CollaborationRoomActivityGateOptions = {
  maxDocuments?: number;
  maxActivitiesPerDocument?: number;
  maxActivities?: number;
};

const DEFAULTS = {
  maxDocuments: 256,
  maxActivitiesPerDocument: 128,
  maxActivities: 1024,
} as const;

function validateLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Bounded, non-expiring admission barrier for in-process room work.
 * This gate does not persist ownership or force-release work during drain.
 */
export function createCollaborationRoomActivityGate(options: CollaborationRoomActivityGateOptions = {}) {
  const maxDocuments = validateLimit('maxDocuments', options.maxDocuments ?? DEFAULTS.maxDocuments);
  const maxActivitiesPerDocument = validateLimit(
    'maxActivitiesPerDocument', options.maxActivitiesPerDocument ?? DEFAULTS.maxActivitiesPerDocument,
  );
  const maxActivities = validateLimit('maxActivities', options.maxActivities ?? DEFAULTS.maxActivities);
  const documents = new Map<string, ActivityRecord>();
  let activeActivities = 0;
  let disposed = false;

  const removeIfIdle = (documentId: string, record: ActivityRecord) => {
    if (record.active === 0 && !record.drain && documents.get(documentId) === record) {
      documents.delete(documentId);
    }
  };

  const admit = (documentId: string): CollaborationRoomActivityLease => {
    if (!documentId) throw new TypeError('documentId must be a non-empty string.');
    if (disposed) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_CLOSED');

    let record = documents.get(documentId);
    if (record?.drain) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_DRAINING');
    if (activeActivities >= maxActivities || (record && record.active >= maxActivitiesPerDocument)
      || (!record && documents.size >= maxDocuments)) {
      throw new CollaborationRoomActivityError('ROOM_ACTIVITY_BUSY');
    }
    if (!record) {
      record = { active: 0 };
      documents.set(documentId, record);
    }

    record.active += 1;
    activeActivities += 1;
    let released = false;
    return {
      assertOpen() {
        if (released || disposed) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_CLOSED');
        if (record?.drain) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_DRAINING');
      },
      release() {
        if (released) return;
        released = true;
        record!.active -= 1;
        activeActivities -= 1;
        if (record!.active === 0) record!.drain?.resolveIdle();
        removeIfIdle(documentId, record!);
      },
    };
  };

  const beginDrain = (documentId: string): CollaborationRoomDrain => {
    if (!documentId) throw new TypeError('documentId must be a non-empty string.');
    if (disposed) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_CLOSED');
    let record = documents.get(documentId);
    if (record?.drain) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_DRAINING');
    if (!record) {
      if (documents.size >= maxDocuments) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_BUSY');
      record = { active: 0 };
      documents.set(documentId, record);
    }

    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    const drain = { idle, resolveIdle, finished: false };
    record.drain = drain;
    if (record.active === 0) resolveIdle();

    return {
      idle,
      finish() {
        if (drain.finished) return;
        if (record!.active !== 0) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_BUSY');
        drain.finished = true;
        if (record!.drain === drain) delete record!.drain;
        removeIfIdle(documentId, record!);
      },
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [documentId, record] of documents) removeIfIdle(documentId, record);
  };

  return {
    admit, beginDrain, dispose,
    // Synchronous observation for idle-only terminal drains. The caller must
    // beginDrain without yielding after this check, never wait on its own lease.
    isIdle: (documentId: string) => {
      const record = documents.get(documentId);
      return !disposed && !record?.drain && (!record || record.active === 0);
    },
  };
}
