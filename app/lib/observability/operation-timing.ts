import 'server-only';

import { performance } from 'node:perf_hooks';

type Now = () => number;

export type OperationTimingSnapshot = {
  totalMs: number;
  phases: Record<string, number>;
};

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createOperationTiming(now: Now = () => performance.now()) {
  const startedAt = now();
  let phaseStartedAt = startedAt;
  const phases: Record<string, number> = {};

  return {
    mark(phase: string): number {
      const current = now();
      const durationMs = roundMilliseconds(Math.max(0, current - phaseStartedAt));
      phases[phase] = roundMilliseconds((phases[phase] ?? 0) + durationMs);
      phaseStartedAt = current;
      return durationMs;
    },
    elapsedMs(): number {
      return roundMilliseconds(Math.max(0, now() - startedAt));
    },
    snapshot(): OperationTimingSnapshot {
      return {
        totalMs: roundMilliseconds(Math.max(0, now() - startedAt)),
        phases: { ...phases },
      };
    },
  };
}

export type OperationTiming = ReturnType<typeof createOperationTiming>;
