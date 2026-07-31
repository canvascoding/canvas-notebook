export const LOCAL_DEVELOPMENT_AUTH_SECRET = 'canvas-notebook-local-dev-secret-change-me';
export const MINIMUM_AUTH_SECRET_LENGTH = 32;

type AuthSecretEnvironment = {
  AUTH_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  NEXT_PHASE?: string;
  NODE_ENV?: string;
};

type ResolveAuthSecretOptions = {
  allowProductionBuildFallback?: boolean;
};

function configuredAuthSecret(environment: AuthSecretEnvironment): string | null {
  return environment.BETTER_AUTH_SECRET?.trim()
    || environment.AUTH_SECRET?.trim()
    || null;
}

function productionSecretError(): Error {
  return new Error(
    `Production requires BETTER_AUTH_SECRET or AUTH_SECRET to be a non-default secret of at least ${MINIMUM_AUTH_SECRET_LENGTH} characters.`
  );
}

function isValidProductionSecret(secret: string | null): secret is string {
  return Boolean(
    secret
    && secret.length >= MINIMUM_AUTH_SECRET_LENGTH
    && secret !== LOCAL_DEVELOPMENT_AUTH_SECRET
  );
}

export function assertProductionAuthSecret(
  environment: AuthSecretEnvironment = process.env
): void {
  if (environment.NODE_ENV !== 'production') return;
  if (!isValidProductionSecret(configuredAuthSecret(environment))) {
    throw productionSecretError();
  }
}

export function resolveAuthSecret(
  environment: AuthSecretEnvironment = process.env,
  options: ResolveAuthSecretOptions = {}
): string {
  const configured = configuredAuthSecret(environment);
  if (environment.NODE_ENV !== 'production') {
    return configured || LOCAL_DEVELOPMENT_AUTH_SECRET;
  }
  if (isValidProductionSecret(configured)) {
    return configured;
  }
  if (
    options.allowProductionBuildFallback
    && environment.NEXT_PHASE === 'phase-production-build'
  ) {
    return LOCAL_DEVELOPMENT_AUTH_SECRET;
  }
  throw productionSecretError();
}
