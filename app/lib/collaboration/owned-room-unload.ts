import 'server-only';

type OwnedRoomTerminalDrain<Snapshot> = Readonly<{
  idle: Promise<void>;
  releaseDurably: (snapshot: Snapshot) => Promise<void>;
  finish: () => void;
}>;

type OwnedRoomUnloadPhase<Snapshot> = {
  drain: OwnedRoomTerminalDrain<Snapshot>;
  phase: 'gated' | 'stored' | 'released';
  snapshot?: Snapshot;
};

export type OwnedRoomUnloadCoordinatorOptions<Document extends object, Snapshot> = Readonly<{
  isCurrent: (document: Document) => boolean;
  shouldUnload: (document: Document) => boolean;
  beforeUnload: (document: Document) => Promise<void>;
  beginIdleDrain: (document: Document) => OwnedRoomTerminalDrain<Snapshot> | undefined;
  withMutationLock: <T>(document: Document, operation: () => Promise<T>) => Promise<T>;
  storeAndCapture: (document: Document) => Promise<Snapshot>;
  destroyCurrent: (document: Document) => void;
  afterUnload: (document: Document) => Promise<void>;
  onCancelled?: (document: Document, error: unknown, phase: 'before' | 'after') => void;
  onFailure: (
    document: Document,
    error: unknown,
    phase: 'begin' | OwnedRoomUnloadPhase<Snapshot>['phase'],
  ) => void;
}>;

/**
 * Runs the positive normal-unload handoff for one exact live document object.
 * The caller owns admission retry scheduling and the Hocuspocus document maps.
 */
export function createOwnedRoomUnloadCoordinator<Document extends object, Snapshot>(
  options: OwnedRoomUnloadCoordinatorOptions<Document, Snapshot>,
) {
  const phases = new WeakMap<Document, OwnedRoomUnloadPhase<Snapshot>>();
  const running = new WeakMap<Document, Promise<void>>();
  const reportFailure = (
    document: Document,
    error: unknown,
    phase: 'begin' | OwnedRoomUnloadPhase<Snapshot>['phase'],
  ) => {
    try { options.onFailure(document, error, phase); }
    catch { /* Detached Hocuspocus unload calls must never reject. */ }
  };

  const attempt = async (document: Document): Promise<void> => {
    let retained = phases.get(document);
    if (!retained) {
      if (!options.isCurrent(document) || !options.shouldUnload(document)) return;
      try {
        await options.beforeUnload(document);
      } catch (error) {
        options.onCancelled?.(document, error, 'before');
        return;
      }
      // This must remain synchronous with beginning the activity drain. A new
      // Direct/startup activity can therefore either precede the drain or be
      // rejected by it, but cannot slip between the two checks.
      if (!options.isCurrent(document) || !options.shouldUnload(document)) return;
      const drain = options.beginIdleDrain(document);
      if (!drain) return;
      retained = { drain, phase: 'gated' };
      phases.set(document, retained);
    }

    try {
      await retained.drain.idle;
      await options.withMutationLock(document, async () => {
        if (!options.isCurrent(document)) throw new Error('Owned room changed during durable unload.');
        if (retained.phase === 'gated') {
          retained.snapshot = await options.storeAndCapture(document);
          retained.phase = 'stored';
        }
        if (retained.phase === 'stored') {
          await retained.drain.releaseDurably(retained.snapshot!);
          retained.phase = 'released';
        }
      });
      options.destroyCurrent(document);
      retained.drain.finish();
      phases.delete(document);
      try { await options.afterUnload(document); }
      catch (error) { options.onCancelled?.(document, error, 'after'); }
    } catch (error) {
      reportFailure(document, error, retained.phase);
    }
  };

  const unload = (document: Document): Promise<void> => {
    const active = running.get(document);
    if (active) return active;
    const promise = Promise.resolve().then(() => attempt(document))
      .catch((error) => { reportFailure(document, error, 'begin'); })
      .finally(() => {
        if (running.get(document) === promise) running.delete(document);
      });
    running.set(document, promise);
    return promise;
  };

  return Object.freeze({
    unload,
    isGated: (document: Document) => phases.has(document),
  });
}
