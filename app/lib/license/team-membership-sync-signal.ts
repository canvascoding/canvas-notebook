import 'server-only';

type TeamMembershipSyncSignalRuntime = {
  listener: (() => void) | null;
};

type TeamMembershipSyncSignalGlobal = typeof globalThis & {
  __canvasTeamMembershipSyncSignal?: TeamMembershipSyncSignalRuntime;
};

function signalRuntime(): TeamMembershipSyncSignalRuntime {
  const globalRuntime = globalThis as TeamMembershipSyncSignalGlobal;
  globalRuntime.__canvasTeamMembershipSyncSignal ??= { listener: null };
  return globalRuntime.__canvasTeamMembershipSyncSignal;
}

export function registerTeamMembershipSyncSignal(listener: (() => void) | null): void {
  signalRuntime().listener = listener;
}

export function signalTeamMembershipSnapshotSync(): boolean {
  const listener = signalRuntime().listener;
  if (!listener) return false;
  listener();
  return true;
}
