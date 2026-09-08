/** One in-flight check per connection; failed access stays denied until rejoin. */
export function createCollaborationAccessMonitor<T extends object>(input: {
  validate: (connection: T) => Promise<void>;
  deny: (connection: T) => void;
  intervalMs?: number;
}) {
  const connections = new Set<T>();
  const denied = new WeakSet<T>();
  const pending = new WeakMap<T, Promise<void>>();
  let disposed = false;
  const check = (connection: T): Promise<void> => {
    if (disposed || denied.has(connection)) return Promise.reject(new Error('Collaboration access is closed.'));
    const running = pending.get(connection);
    if (running) return running;
    const validation = Promise.resolve().then(() => input.validate(connection)).then(() => {
      if (disposed || denied.has(connection)) throw new Error('Collaboration access is closed.');
    }).catch((error) => {
      const alreadyDenied = denied.has(connection);
      denied.add(connection);
      connections.delete(connection);
      if (!alreadyDenied) input.deny(connection);
      throw error;
    }).finally(() => pending.delete(connection));
    pending.set(connection, validation);
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
      return () => { connections.delete(connection); denied.add(connection); };
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      connections.clear();
    },
  };
}
