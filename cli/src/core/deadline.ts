import { performance } from 'node:perf_hooks';

type MonotonicClock = () => number;

const systemMonotonicClock: MonotonicClock = () => performance.now();

export function monotonicDeadlineMs(
  timeoutSeconds: number,
  clock: MonotonicClock = systemMonotonicClock,
): number {
  return clock() + timeoutSeconds * 1000;
}

export function remainingMonotonicSeconds(
  deadlineMs: number,
  clock: MonotonicClock = systemMonotonicClock,
): number {
  return Math.max(0, Math.ceil((deadlineMs - clock()) / 1000));
}
