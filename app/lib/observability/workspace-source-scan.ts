import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

type Phase = 'catalogue' | 'filesystem' | 'native' | 'physical' | 'revalidation';
export type WorkspaceSourceScanMeasurement = Readonly<{
  component: 'workspace_source_scan'; elapsedMs: number; complete: boolean;
  sources: number; gaps: number; phases: Readonly<Partial<Record<Phase, number>>>;
}>;
type Observer = (value: WorkspaceSourceScanMeasurement) => void;
const observers = new AsyncLocalStorage<Observer>();

/** Diagnostics only: no source paths, content, credentials or authority. */
export function withWorkspaceSourceScanObserver<T>(observe: Observer, operation: () => Promise<T>): Promise<T> {
  return observers.run(observe, operation);
}

export function beginWorkspaceSourceScan() {
  const started = performance.now();
  let last = started;
  const phases: Partial<Record<Phase, number>> = {};
  return {
    checkpoint(phase: Phase) {
      const now = performance.now();
      phases[phase] = Math.round((phases[phase] ?? 0) + now - last);
      last = now;
    },
    finish(complete: boolean, sources: number, gaps: number) {
      const value: WorkspaceSourceScanMeasurement = Object.freeze({ component: 'workspace_source_scan',
        elapsedMs: Math.round(performance.now() - started), complete, sources, gaps,
        phases: Object.freeze({ ...phases }) });
      try { observers.getStore()?.(value); } catch { /* Diagnostics cannot change source authority. */ }
      if (value.elapsedMs >= 1000) {
        try { console.info(JSON.stringify(value)); } catch { /* Logging is best-effort. */ }
      }
    },
  };
}
