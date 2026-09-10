import { executeAutomationRun } from './runner';
import { createAutomationRunDispatcher } from './dispatch-limiter';

const dispatchAutomationRun = createAutomationRunDispatcher(executeAutomationRun);

export function dispatchAutomationRunExecution(runId: string): boolean {
  return dispatchAutomationRun(runId);
}
