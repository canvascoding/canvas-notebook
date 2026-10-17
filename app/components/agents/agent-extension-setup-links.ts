import type { AgentExtensionSetupAlternative } from '@/app/lib/agents/extension-options-contracts';

export type AgentExtensionSetupLink = { key: string; href: string; label: string; source: 'mcp' | 'composio'; connector?: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

/** Navigation only. Never send a package head, account, receipt, provider ref or draft contents in a setup URL. */
export function buildAgentExtensionSetupLinks({ alternatives, workspaceId, locale }: {
  alternatives: unknown; workspaceId: string | null; locale: string;
}): AgentExtensionSetupLink[] {
  const result: AgentExtensionSetupLink[] = [];
  if (!Array.isArray(alternatives)) return result;
  for (const value of alternatives) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160 || /[\p{Cc}\p{Cf}]/u.test(value.label)
      || value.alternativeKey !== undefined && (typeof value.alternativeKey !== 'string' || value.alternativeKey.length > 137 || /[\p{Cc}\p{Cf}]/u.test(value.alternativeKey))) continue;
    const alternative = value as AgentExtensionSetupAlternative;
    const query = new URLSearchParams({ view: 'browse', ...(workspaceId ? { workspaceId } : {}) });
    if (alternative.source === 'composio') {
      if (typeof alternative.toolkit !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(alternative.toolkit)) continue;
      query.set('extensionId', `composio:${alternative.toolkit}`);
    } else if (alternative.source === 'mcp') {
      if (alternative.connector !== undefined && (typeof alternative.connector !== 'string' || !alternative.connector.trim()
        || alternative.connector.length > 128 || /[\p{Cc}\p{Cf}]/u.test(alternative.connector))) continue;
      if (alternative.definitionId !== undefined) {
        if (typeof alternative.definitionId !== 'string' || !uuid.test(alternative.definitionId)) continue;
        query.set('extensionId', `mcp-definition:${alternative.definitionId}`);
      } else query.set('setup', 'mcp');
    } else continue;
    const key = JSON.stringify([alternative.source, alternative.alternativeKey ?? null,
      alternative.source === 'composio' ? alternative.toolkit : [alternative.connector ?? null, alternative.definitionId ?? null]]);
    result.push({ key, href: `/${locale === 'de' ? 'de' : 'en'}/plugins?${query}`, label: alternative.label, source: alternative.source,
      ...(alternative.source === 'mcp' && alternative.connector ? { connector: alternative.connector } : {}) });
  }
  return [...new Map(result.map(value => [value.key, value])).values()];
}
