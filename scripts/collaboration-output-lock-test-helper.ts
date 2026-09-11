import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';

/** Exercise live access outside the lock owner's reentrant async context. */
export async function whileWorkspaceOutputBlocked(workspaceId: string, operation: () => Promise<void>) {
  let entered!: () => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const holding = withWorkspaceMutationLock(workspaceId, async () => { entered(); await released; });
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([acquired, holding]);
    pending = operation();
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Live access waited for the workspace output lock')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    await holding;
    // A failing regression must still finish its database work before teardown.
    if (pending) await Promise.allSettled([pending]);
  }
}
