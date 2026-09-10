type AutomationRunExecutor = (runId: string) => Promise<void>;

function resolveMaxConcurrentRuns(value = process.env.CANVAS_AUTOMATION_MAX_CONCURRENT_RUNS): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 2;
}

export function createAutomationRunDispatcher(
  executor: AutomationRunExecutor,
  maxConcurrentRuns = resolveMaxConcurrentRuns(),
): (runId: string) => boolean {
  const activeDispatches = new Map<string, Promise<void>>();
  const concurrencyLimit = Math.max(1, Math.min(Math.floor(maxConcurrentRuns), 10));

  return (runId: string): boolean => {
    if (activeDispatches.has(runId) || activeDispatches.size >= concurrencyLimit) {
      return false;
    }

    const execution = executor(runId)
      .catch((error) => {
        console.error(`[Automationen] Run dispatch failed for ${runId}:`, error);
      })
      .finally(() => {
        activeDispatches.delete(runId);
      });

    activeDispatches.set(runId, execution);
    return true;
  };
}
