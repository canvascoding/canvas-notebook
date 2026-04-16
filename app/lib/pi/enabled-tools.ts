export const DISABLED_ALL_TOOLS_SENTINEL = '__none__';

const LEGACY_TOOL_NAMES = new Set(['filesystem', 'terminal', 'web-search']);

function normalizeToolNames(toolNames: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const toolName of toolNames) {
    const normalized = toolName.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function normalizeEnabledToolsConfig(enabledTools?: string[] | null): string[] {
  if (!Array.isArray(enabledTools)) {
    return [];
  }

  return normalizeToolNames(enabledTools);
}

export function isLegacyEnabledToolsValue(enabledTools?: string[] | null): boolean {
  const normalized = normalizeEnabledToolsConfig(enabledTools);
  if (normalized.length === 0) {
    return false;
  }

  return normalized.every((toolName) => LEGACY_TOOL_NAMES.has(toolName));
}

export function resolveEnabledToolNames(
  allToolNames: Iterable<string>,
  enabledTools?: string[] | null,
): Set<string> {
  const canonicalToolNames = normalizeToolNames(allToolNames);
  const canonicalToolSet = new Set(canonicalToolNames);
  const configuredTools = normalizeEnabledToolsConfig(enabledTools).filter(
    (toolName) => toolName !== DISABLED_ALL_TOOLS_SENTINEL,
  );

  if (configuredTools.length === 0 || isLegacyEnabledToolsValue(enabledTools)) {
    return new Set(canonicalToolNames);
  }

  return new Set(configuredTools.filter((toolName) => canonicalToolSet.has(toolName)));
}

export function areAllToolsEnabled(enabledTools?: string[] | null): boolean {
  return normalizeEnabledToolsConfig(enabledTools).length === 0 || isLegacyEnabledToolsValue(enabledTools);
}

export function serializeEnabledToolNames(
  enabledToolNames: Iterable<string>,
  allToolNames: Iterable<string>,
): string[] {
  const canonicalToolNames = normalizeToolNames(allToolNames);
  const enabledSet = new Set(normalizeToolNames(enabledToolNames));
  const orderedEnabledNames = canonicalToolNames.filter((toolName) => enabledSet.has(toolName));

  if (orderedEnabledNames.length === 0) {
    return [DISABLED_ALL_TOOLS_SENTINEL];
  }

  if (orderedEnabledNames.length === canonicalToolNames.length) {
    return [];
  }

  return orderedEnabledNames;
}

export function enableToolInConfig(
  toolName: string,
  enabledTools: string[] | null | undefined,
  allToolNames: Iterable<string>,
): string[] {
  const enabledSet = resolveEnabledToolNames(allToolNames, enabledTools);
  enabledSet.add(toolName);
  return serializeEnabledToolNames(enabledSet, allToolNames);
}

export function disableToolInConfig(
  toolName: string,
  enabledTools: string[] | null | undefined,
  allToolNames: Iterable<string>,
): string[] {
  const enabledSet = resolveEnabledToolNames(allToolNames, enabledTools);
  enabledSet.delete(toolName);
  return serializeEnabledToolNames(enabledSet, allToolNames);
}