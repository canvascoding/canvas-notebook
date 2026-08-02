import 'server-only';

type TeamMembershipSyncSignalRuntime = {
  listener: ((options?: { forceReport?: boolean }) => void) | null;
};

type TeamMembershipSyncSignalGlobal = typeof globalThis & {
  __canvasTeamMembershipSyncSignal?: TeamMembershipSyncSignalRuntime;
};

function signalRuntime(): TeamMembershipSyncSignalRuntime {
  const globalRuntime = globalThis as TeamMembershipSyncSignalGlobal;
  globalRuntime.__canvasTeamMembershipSyncSignal ??= { listener: null };
  return globalRuntime.__canvasTeamMembershipSyncSignal;
}

export function registerTeamMembershipSyncSignal(
  listener: ((options?: { forceReport?: boolean }) => void) | null,
): void {
  signalRuntime().listener = listener;
}

export function signalTeamMembershipSnapshotSync(
  options?: { forceReport?: boolean },
): boolean {
  const listener = signalRuntime().listener;
  if (!listener) return false;
  listener(options);
  return true;
}
