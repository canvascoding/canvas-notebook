import 'server-only';

type TeamSeatOutboxWorkerSignalRuntime = {
  listener: (() => void) | null;
};

type TeamSeatOutboxWorkerSignalGlobal = typeof globalThis & {
  __canvasTeamSeatOutboxWorkerSignal?: TeamSeatOutboxWorkerSignalRuntime;
};

function signalRuntime(): TeamSeatOutboxWorkerSignalRuntime {
  const globalRuntime = globalThis as TeamSeatOutboxWorkerSignalGlobal;
  globalRuntime.__canvasTeamSeatOutboxWorkerSignal ??= { listener: null };
  return globalRuntime.__canvasTeamSeatOutboxWorkerSignal;
}

export function registerTeamSeatOutboxWorkerSignal(
  listener: (() => void) | null,
): void {
  signalRuntime().listener = listener;
}

export function signalTeamSeatOutboxWorker(): boolean {
  const listener = signalRuntime().listener;
  if (!listener) return false;
  listener();
  return true;
}
