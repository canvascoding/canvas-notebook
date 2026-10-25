import fs from 'node:fs';

/** A deleted or replaced checkout cannot keep consuming shared durable jobs. */
export function watchDevCheckout(cwd, onUnavailable, intervalMs = 1_000) {
  const original = fs.statSync(cwd);
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const current = fs.statSync(cwd);
      if (current.isDirectory() && current.dev === original.dev && current.ino === original.ino) return;
    } catch { /* An unconfirmed checkout must no longer own background work. */ }
    stop();
    onUnavailable();
  }, intervalMs);
  timer.unref();
  return stop;
}
