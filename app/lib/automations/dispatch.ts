import { executeAutomationRun } from './runner';

const activeAutomationRunDispatches = new Map<string, Promise<void>>();

export function dispatchAutomationRunExecution(runId: string): boolean {
  if (activeAutomationRunDispatches.has(runId)) {
    return false;
  }

  const execution = executeAutomationRun(runId)
    .catch((error) => {
      console.error(`[Automationen] Run dispatch failed for ${runId}:`, error);
    })
    .finally(() => {
      activeAutomationRunDispatches.delete(runId);
    });

  activeAutomationRunDispatches.set(runId, execution);
  return true;
}
