export const DEFAULT_BOOTSTRAP_SEED_PLUGIN_NAMES = [
  'document-suite',
] as const;

export type DefaultBootstrapSeedPluginName = (typeof DEFAULT_BOOTSTRAP_SEED_PLUGIN_NAMES)[number];

export function parseBootstrapSeedPluginNames(configuredValue?: string | null): Set<string> {
  const configured = configuredValue?.trim();
  if (!configured) {
    return new Set(DEFAULT_BOOTSTRAP_SEED_PLUGIN_NAMES);
  }

  return new Set(
    configured
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}
