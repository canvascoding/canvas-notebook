import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

type Phase = 'catalogue' | 'filesystem' | 'native' | 'physical' | 'revalidation';
export type WorkspaceSourceScanMeasurement = Readonly<{
  component: 'workspace_source_scan'; elapsedMs: number; complete: boolean;
  sources: number; gaps: number; gapCodes: readonly string[]; phases: Readonly<Partial<Record<Phase, number>>>;
  readWaitMs: Readonly<Partial<Record<Phase, number>>>;
  workMs: Readonly<Partial<Record<Phase, number>>>;
}>;
// Only fixed public domain codes enter telemetry. Never log parser input,
// filenames, error messages or arbitrary exception properties.
const diagnosticCodes = new Set([
  'identity-conflict', 'invalid-workspace-root', 'missing-native-state', 'native-identity-conflict',
  'native-source-changed', 'path-count-limit', 'physical-authority-changed', 'physical-scope-changed',
  'physical-source-changed', 'source-authority-changed', 'source-byte-limit', 'source-depth-limit',
  'source-link-limit', 'source-namespace-limit', 'invalid-source-path', 'missing-physical-source',
  'source-authority-unavailable', 'unreadable-physical-source', 'unreadable-source-directory',
  'unsafe-physical-source', 'unsupported-mdx-source', 'unreadable-native-source', 'invalid-native-state',
  'source-too-large', 'uninspected-html',
]);
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
  const reads: Partial<Record<Phase, number>> = {};
  return {
    async read<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try { return await operation(); }
      finally { reads[phase] = (reads[phase] ?? 0) + performance.now() - start; }
    },
    checkpoint(phase: Phase) {
      const now = performance.now();
      phases[phase] = Math.round((phases[phase] ?? 0) + now - last);
      last = now;
    },
    finish(complete: boolean, sources: number, gaps: number, codes: readonly string[] = []) {
      const value: WorkspaceSourceScanMeasurement = Object.freeze({ component: 'workspace_source_scan',
        elapsedMs: Math.round(performance.now() - started), complete, sources, gaps,
        gapCodes: Object.freeze([...new Set(codes.map(code => diagnosticCodes.has(code) ? code : 'other'))].sort()),
        phases: Object.freeze({ ...phases }),
        readWaitMs: Object.freeze(Object.fromEntries(Object.entries(reads).map(([phase, duration]) => [phase, Math.round(duration)]))),
        workMs: Object.freeze(Object.fromEntries(Object.entries(phases).map(([phase, duration]) =>
          [phase, Math.max(0, Math.round(duration - (reads[phase as Phase] ?? 0)))]))),
      });
      try { observers.getStore()?.(value); } catch { /* Diagnostics cannot change source authority. */ }
      if (value.elapsedMs >= 1000) {
        try { console.info(JSON.stringify(value)); } catch { /* Logging is best-effort. */ }
      }
    },
  };
}
