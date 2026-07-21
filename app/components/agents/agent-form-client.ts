import {
  DISABLED_ALL_TOOLS_SENTINEL,
  getDefaultEnabledToolNames,
  isDefaultToolsConfig,
  resolveEnabledToolNames,
  serializeEnabledToolNames,
} from '@/app/lib/pi/enabled-tools';

export async function fetchAgentFormJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: T;
  };
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload.data as T;
}

export function getExplicitEnabledToolsFromConfig(
  tools: Array<{ name: string }>,
  configuredTools: string[] | null,
): string[] | null {
  if (!configuredTools) return null;
  if (configuredTools.includes(DISABLED_ALL_TOOLS_SENTINEL)) {
    return [DISABLED_ALL_TOOLS_SENTINEL];
  }
  const allNames = tools.map((tool) => tool.name);
  const enabledSet = isDefaultToolsConfig(configuredTools)
    ? getDefaultEnabledToolNames(allNames)
    : resolveEnabledToolNames(allNames, configuredTools);
  return serializeEnabledToolNames(enabledSet, allNames);
}

export function isExactAgentDeleteConfirmation(value: string, agentName: string): boolean {
  return value === agentName;
}
