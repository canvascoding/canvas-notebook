/** One in-flight check per connection; confirmed denial stays until rejoin. */
export function createCollaborationAccessMonitor<T extends object>(input: {
  validate: (connection: T) => Promise<void>;
  deny: (connection: T) => void;
  /** A transient failure still rejects this check: it never permits a write. */
  isTransient?: (error: unknown) => boolean;
  intervalMs?: number;
}) {
  const connections = new Set<T>();
  const denied = new WeakSet<T>();
  const pending = new WeakMap<T, Promise<void>>();
  const activeChecks = new Set<Promise<void>>();
  let disposed = false;
  const check = (connection: T): Promise<void> => {
    if (disposed || denied.has(connection)) return Promise.reject(new Error('Collaboration access is closed.'));
    const running = pending.get(connection);
    if (running) return running;
    const validation = Promise.resolve().then(() => input.validate(connection)).then(() => {
      if (disposed || denied.has(connection)) throw new Error('Collaboration access is closed.');
    }).catch((error) => {
      if (!disposed && !denied.has(connection) && input.isTransient?.(error)) throw error;
      const alreadyDenied = denied.has(connection);
      denied.add(connection);
      connections.delete(connection);
      if (!alreadyDenied) input.deny(connection);
      throw error;
    }).finally(() => { pending.delete(connection); activeChecks.delete(validation); });
    pending.set(connection, validation);
    activeChecks.add(validation);
    return validation;
  };
  const sweep = async () => {
    await Promise.allSettled([...connections].map(check));
  };
  const timer = setInterval(() => { void sweep(); }, input.intervalMs ?? 1000);
  timer.unref?.();
  return {
    check,
    sweep,
    add(connection: T) {
      if (disposed) throw new Error('Collaboration access monitor is closed.');
      connections.add(connection);
      return async () => {
        connections.delete(connection); denied.add(connection);
        const running = pending.get(connection);
        if (running) await Promise.allSettled([running]);
      };
    },
    async dispose() {
      disposed = true;
      clearInterval(timer);
      connections.clear();
      await Promise.allSettled([...activeChecks]);
    },
  };
}
