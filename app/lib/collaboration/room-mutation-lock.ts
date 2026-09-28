type Release = () => void;

type RoomMutationLockOptions = {
  maxRoomWaiters?: number;
  maxTotalWaiters?: number;
  acquireTimeoutMs?: number;
};

type RoomMutationLock = {
  acquire: (document: object) => Promise<Release>;
  withLock: <T>(document: object, operation: () => Promise<T> | T) => Promise<T>;
};

type Waiter = {
  active: boolean;
  reject: (error: Error) => void;
  resolve: (release: Release) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RoomState = {
  owner: symbol | null;
  waiters: Waiter[];
};

const DEFAULT_MAX_ROOM_WAITERS = 64;
const DEFAULT_MAX_TOTAL_WAITERS = 1024;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const GLOBAL_LOCK_KEY = Symbol.for('canvas.collaboration.room-mutation-lock');

function validateLimit(name: string, value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  if (value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
}

/** Create an isolated room-lock manager. Useful for testing custom queue limits. */
export function createCollaborationRoomMutationLock(
  options: RoomMutationLockOptions = {},
): RoomMutationLock {
  const maxRoomWaiters = options.maxRoomWaiters ?? DEFAULT_MAX_ROOM_WAITERS;
  const maxTotalWaiters = options.maxTotalWaiters ?? DEFAULT_MAX_TOTAL_WAITERS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  validateLimit('maxRoomWaiters', maxRoomWaiters, true);
  validateLimit('maxTotalWaiters', maxTotalWaiters, true);
  validateLimit('acquireTimeoutMs', acquireTimeoutMs, true);
  if (acquireTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`acquireTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }

  const rooms = new WeakMap<object, RoomState>();
  let totalWaiters = 0;

  const createRelease = (room: RoomState, owner: symbol): Release => {
    let released = false;
    return () => {
      if (released || room.owner !== owner) return;
      released = true;

      let next: Waiter | undefined;
      while ((next = room.waiters.shift())) {
        if (!next.active) continue;
        next.active = false;
        clearTimeout(next.timer);
        totalWaiters -= 1;
        room.owner = Symbol('room-mutation-owner');
        next.resolve(createRelease(room, room.owner));
        return;
      }

      room.owner = null;
    };
  };

  const acquire = (document: object): Promise<Release> => {
    let room = rooms.get(document);
    if (!room) {
      room = { owner: null, waiters: [] };
      rooms.set(document, room);
    }

    if (room.owner === null) {
      room.owner = Symbol('room-mutation-owner');
      return Promise.resolve(createRelease(room, room.owner));
    }

    const roomWaiterCount = room.waiters.reduce((count, waiter) => count + Number(waiter.active), 0);
    if (roomWaiterCount >= maxRoomWaiters || totalWaiters >= maxTotalWaiters) {
      return Promise.reject(new Error('Collaboration room mutation queue is full'));
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        active: true,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!waiter.active) return;
          waiter.active = false;
          const index = room!.waiters.indexOf(waiter);
          if (index !== -1) room!.waiters.splice(index, 1);
          totalWaiters -= 1;
          reject(new Error('Timed out waiting for collaboration room mutation lock'));
        }, acquireTimeoutMs),
      };
      room!.waiters.push(waiter);
      totalWaiters += 1;
    });
  };

  return {
    acquire,
    async withLock<T>(document: object, operation: () => Promise<T> | T): Promise<T> {
      const release = await acquire(document);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

const globalRegistry = globalThis as unknown as Record<PropertyKey, unknown>;
let sharedLock = globalRegistry[GLOBAL_LOCK_KEY] as RoomMutationLock | undefined;
if (!sharedLock) {
  sharedLock = createCollaborationRoomMutationLock();
  Object.defineProperty(globalThis, GLOBAL_LOCK_KEY, {
    configurable: false,
    enumerable: false,
    value: sharedLock,
    writable: false,
  });
}

/** Acquire the process-wide FIFO mutation lock for this exact room Doc object. */
export function acquireCollaborationRoomMutationLock(document: object): Promise<Release> {
  return sharedLock!.acquire(document);
}

/** Run an operation under the process-wide mutation lock for this room Doc. */
export function withCollaborationRoomMutationLock<T>(
  document: object,
  operation: () => Promise<T> | T,
): Promise<T> {
  return sharedLock!.withLock(document, operation);
}
