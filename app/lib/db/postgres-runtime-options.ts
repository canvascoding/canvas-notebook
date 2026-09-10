export type PostgresRuntimeOptions = {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
};

function resolvePositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function resolvePostgresRuntimeOptions(
  environment: Record<string, string | undefined> = process.env,
): PostgresRuntimeOptions {
  return {
    max: resolvePositiveInteger(environment.CANVAS_POSTGRES_POOL_MAX, 10, 100),
    idleTimeoutMillis: resolvePositiveInteger(
      environment.CANVAS_POSTGRES_IDLE_TIMEOUT_MS,
      30_000,
      3_600_000,
    ),
    // Match pg's default: 0 leaves acquisition/connection startup unbounded.
    // Finite deadlines are explicit operator overrides, not a cold-start default.
    connectionTimeoutMillis: resolvePositiveInteger(
      environment.CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS,
      0,
      60_000,
    ),
  };
}
