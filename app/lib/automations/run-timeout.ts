export class AutomationRunTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Automation run timed out after ${timeoutMs}ms`);
    this.name = 'AutomationRunTimeoutError';
  }
}

export class AutomationLoopShutdownError extends Error {
  readonly loopQuiescent = false;
  readonly operationSettlement: Promise<void>;

  constructor(graceMs: number, operationSettlement: Promise<void>) {
    super(`Automation timed out and its execution did not stop within ${graceMs}ms.`);
    this.name = 'AutomationLoopShutdownError';
    this.operationSettlement = operationSettlement;
  }
}

async function waitForPromiseSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runWithAutomationTimeout<T>(input: {
  timeoutMs: number;
  abortGraceMs: number;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const operationPromise = Promise.resolve().then(() => input.operation(controller.signal));
  const operationSettlement = operationPromise.then(() => undefined, () => undefined);
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new AutomationRunTimeoutError(input.timeoutMs));
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof AutomationRunTimeoutError) {
      const stopped = await waitForPromiseSettlement(operationPromise, input.abortGraceMs);
      if (!stopped) {
        throw new AutomationLoopShutdownError(input.abortGraceMs, operationSettlement);
      }
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
