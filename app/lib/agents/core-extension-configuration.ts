import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import type { ExtensionSelectionEntry } from '@/app/lib/capabilities/extensions/contracts';
import { withAuthorizedCorePluginSource, withAuthorizedCoreSkillSource, withAuthorizedCoreExtensionSelection } from '@/app/lib/capabilities/extensions/core-source';
import { isCoreExtensionSelection } from '@/app/lib/capabilities/extensions/core-source-contracts';
import { parseStoredCoreExtensionBinding, type StoredCoreExtensionBinding } from '@/app/lib/capabilities/extensions/stored-core-contracts';
import type { AgentManagementActor } from './management-actions';

export type PreparedAgentCorePlugin = { stored: StoredCoreExtensionBinding; skillNames: string[] };

export async function prepareAgentCorePluginConfigurations(actor: AgentManagementActor,
  selections: readonly ExtensionSelectionEntry[]): Promise<PreparedAgentCorePlugin[]> {
  const result: PreparedAgentCorePlugin[] = [];
  for (const entry of selections) {
    if (!isCoreExtensionSelection(entry.selection)) continue;
    const stored = parseStoredCoreExtensionBinding({ version: 2, kind: entry.selection.kind, entry });
    const skillNames = stored.entry.selection.kind === 'core_plugin'
      ? await withAuthorizedCorePluginSource(actor, stored.entry.selection.coreSource, async plugin => plugin.skills.map(skill => skill.name))
      : await withAuthorizedCoreSkillSource(actor, stored.entry.selection.coreSource, async skill => [skill.name]);
    result.push({ stored, skillNames });
  }
  return result.sort((left, right) => left.stored.entry.selection.coreSource.resourceRef.localeCompare(right.stored.entry.selection.coreSource.resourceRef));
}

/** Core Use/hash checks use the actual caller lease before the Agent row lock. */
export async function withAgentCorePluginSources<T>(database: SqlConnection, actor: AgentManagementActor,
  sources: readonly StoredCoreExtensionBinding[], callback: () => Promise<T>): Promise<T> {
  const ordered = [...sources].sort((left, right) => left.entry.selection.coreSource.resourceRef.localeCompare(right.entry.selection.coreSource.resourceRef));
  const next = (index: number): Promise<T> => index === ordered.length ? callback()
    : withAuthorizedCoreExtensionSelection(actor, ordered[index].entry.selection, () => next(index + 1), { database });
  return next(0);
}
