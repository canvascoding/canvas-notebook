import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// Only these static names cross the HTTP boundary. Never record search text,
// actor/account identifiers, request bodies, provider errors or source paths.
type Stage = 'context' | 'packages' | 'store' | 'composio' | 'mcp' | 'revalidate'
  | 'projection' | 'recents' | 'preview' | 'catalog' | 'package_source' | 'icon';
type Measurement = { calls: number; milliseconds: number; items: number };
const observations = new AsyncLocalStorage<Map<Stage, Measurement>>();

export async function observeExtensionStage<T>(stage: Stage, callback: () => Promise<T>,
  count?: (result: T) => number): Promise<T> {
  const scope = observations.getStore();
  if (!scope) return callback();
  const started = performance.now();
  const value = scope.get(stage) ?? { calls: 0, milliseconds: 0, items: 0 };
  scope.set(stage, value);
  value.calls += 1;
  try {
    const result = await callback();
    const items = count?.(result) ?? 0;
    if (Number.isSafeInteger(items) && items >= 0) value.items += items;
    return result;
  } finally { value.milliseconds += performance.now() - started; }
}

/** Request-local diagnostics; no retained metadata or authorization decisions. */
export async function withExtensionObservation<T>(callback: () => Promise<T>): Promise<{ result: T; serverTiming: string }> {
  const scope = new Map<Stage, Measurement>(), started = performance.now();
  const result = await observations.run(scope, callback);
  const timings = [...scope].map(([stage, value]) => `${stage};dur=${value.milliseconds.toFixed(1)};desc="${value.calls} calls, ${value.items} items"`);
  return { result, serverTiming: [`extension;dur=${(performance.now() - started).toFixed(1)}`, ...timings].join(', ') };
}
