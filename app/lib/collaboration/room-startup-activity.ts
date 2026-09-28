import {
  CollaborationRoomActivityError,
  type CollaborationRoomActivityLease,
} from './room-activity-gate';

/**
 * Holds an admitted room lease across asynchronous startup phases. Cancellation
 * closes admission to later phases; only `finish` marks cleanup/connection setup
 * as settled and permits release once every started phase has actually returned.
 */
export function createCollaborationRoomStartupActivity(input: {
  activity: CollaborationRoomActivityLease;
  onFinished?: () => void;
}) {
  let cancelled = false;
  let settled = false;
  let inFlight = 0;
  let released = false;
  let finishedNotified = false;

  const assertOpen = () => {
    if (cancelled) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_CLOSED');
    input.activity.assertOpen();
  };

  const releaseIfIdle = () => {
    if (!settled || inFlight !== 0 || released) return;
    released = true;
    try {
      input.activity.release();
    } finally {
      if (!finishedNotified) {
        finishedNotified = true;
        input.onFinished?.();
      }
    }
  };

  const cancel = () => {
    cancelled = true;
  };

  const finish = () => {
    cancelled = true;
    settled = true;
    releaseIfIdle();
  };

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (cancelled) throw new CollaborationRoomActivityError('ROOM_ACTIVITY_CLOSED');
    inFlight += 1;
    try {
      assertOpen();
      const result = await operation();
      assertOpen();
      return result;
    } catch (error) {
      cancel();
      throw error;
    } finally {
      inFlight -= 1;
      releaseIfIdle();
    }
  };

  return { run, cancel, finish, assertOpen };
}
