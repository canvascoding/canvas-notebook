import { createHash } from 'node:crypto';
import { measurePiContextStatus } from './context-status-measurement';
import { createPiRuntimeContextStatusProjection } from './runtime-context-status';

type Measurement = {
  projection: Awaited<ReturnType<typeof measurePiContextStatus>>;
  measuredAt: string | null;
  state: 'current' | 'unavailable';
};
const measurements = new Map<string, { expiresAt: number; promise: Promise<Measurement> }>();

/** Bounded cache of normalized saved-context measurements. Scope and complete
 * inputs form the fingerprint. Content is neither retained as a key nor logged.
 */
export function measureStoredPiContextStatus(
  scope: string,
  ...args: Parameters<typeof measurePiContextStatus>
): Promise<Measurement> {
  const key = createHash('sha256').update(scope).update(JSON.stringify(args)).digest('hex');
  const cached = measurements.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise: Promise<Measurement> = measurePiContextStatus(...args).then((projection) => ({
    projection,
    measuredAt: new Date().toISOString(),
    state: 'current' as const,
  }), () => ({
    projection: createPiRuntimeContextStatusProjection({ composition: args[0], contextWindow: args[1].model.contextWindow }),
    measuredAt: null,
    state: 'unavailable' as const,
  }));
  const entry = { promise, expiresAt: Date.now() + 30_000 };
  measurements.set(key, entry);
  while (measurements.size > 32) measurements.delete(measurements.keys().next().value!);
  return promise;
}
