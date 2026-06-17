export const DEFAULT_BOOTSTRAP_SEED_SKILL_NAMES = [
  'create-plugin',
  'skill-creator',
  'frontend-slides',
  'marp-slides',
  'find-skills',
] as const;

export type DefaultBootstrapSeedSkillName = (typeof DEFAULT_BOOTSTRAP_SEED_SKILL_NAMES)[number];

export function parseBootstrapSeedSkillNames(configuredValue?: string | null): Set<string> {
  const configured = configuredValue?.trim();
  if (!configured) {
    return new Set(DEFAULT_BOOTSTRAP_SEED_SKILL_NAMES);
  }

  return new Set(
    configured
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}
