/** Shared process control with no DB imports or import-time timers. */
export function notifyEmailClassificationSettingsChanged(): boolean {
  const runtime = (globalThis as typeof globalThis & { __canvasEmailClassificationRuntime?: {
    stopped: boolean; worker: { cancelActive(): void }; trigger(): void;
  } }).__canvasEmailClassificationRuntime;
  if (!runtime || runtime.stopped) return false;
  runtime.worker.cancelActive();
  runtime.trigger();
  return true;
}
