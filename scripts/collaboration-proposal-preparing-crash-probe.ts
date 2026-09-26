export type PreparingCrashPoint = 'prepared-before-apply';

type QueryFunction = (...args: unknown[]) => unknown;

type QueryClientPrototype = {
  query: QueryFunction;
};

type ProposalPreparingCrashProbeOptions = {
  clientPrototype: QueryClientPrototype;
  verify: (input: { operationId: string; casVersion: number; runGeneration: number }) => Promise<boolean>;
  interrupt: (operationId: string) => Promise<never>;
};

const PREPARING_TRANSITION_SQL =
  'UPDATE collaboration_agent_operations SET status = $1, updated_at = $2, cas_version = cas_version + 1 WHERE operation_id = $3 AND cas_version = $4 AND run_generation = $5 AND status IN ($6)';

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ');
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeCasVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidBoundedOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

/**
 * Intercepts the one preparing-to-applying CAS transition used by crash tests.
 * It never performs a SQL write itself: a verified target is interrupted before
 * the original query can execute.
 */
export function installProposalPreparingCrashProbe(
  options: ProposalPreparingCrashProbeOptions,
): () => void {
  const { clientPrototype } = options;
  const originalQuery = clientPrototype.query;
  let targetInterruptionClaimed = false;

  const wrappedQuery: QueryFunction = function (this: unknown, ...args: unknown[]): unknown {
    if (
      args.length !== 2
      || typeof args[0] !== 'string'
      || !Array.isArray(args[1])
      || normalizeSql(args[0]) !== PREPARING_TRANSITION_SQL
    ) {
      return Reflect.apply(originalQuery, this, args);
    }

    const params = args[1] as unknown[];
    const operationId = params[2];
    const casVersion = params[3];
    const runGeneration = params[4];
    if (
      params.length !== 6
      || params[0] !== 'applying'
      || !isSafePositiveInteger(params[1])
      || !isValidBoundedOperationId(operationId)
      || !isSafeCasVersion(casVersion)
      || runGeneration !== 1
      || params[5] !== 'preparing'
    ) {
      return Reflect.apply(originalQuery, this, args);
    }

    return (async (receiver: unknown): Promise<unknown> => {
      const verified = await options.verify({ operationId, casVersion, runGeneration });
      if (!verified) return Reflect.apply(originalQuery, receiver, args);

      if (targetInterruptionClaimed) {
        throw new Error('Preparing crash probe already interrupted its verified target.');
      }
      targetInterruptionClaimed = true;
      await options.interrupt(operationId);
      throw new Error('Preparing crash probe interrupt unexpectedly returned.');
    })(this);
  };

  clientPrototype.query = wrappedQuery;
  return () => {
    if (clientPrototype.query === wrappedQuery) clientPrototype.query = originalQuery;
  };
}
