function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredOriginValues(): Array<string | undefined> {
  return [
    process.env.BETTER_AUTH_BASE_URL,
    process.env.BASE_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',') ?? []),
  ];
}

export function getConfiguredTrustedOrigins(): string[] {
  const origins = new Set(
    configuredOriginValues()
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin)),
  );

  // A normal local `npm run dev` does not require auth URL configuration. Keep
  // that workflow working while requiring an explicit origin in production.
  if (origins.size === 0 && process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT?.trim() || '3000';
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
  }

  return [...origins];
}

export function isConfiguredTrustedOrigin(value: string | undefined): boolean {
  const origin = normalizeOrigin(value);
  return Boolean(origin && getConfiguredTrustedOrigins().includes(origin));
}
