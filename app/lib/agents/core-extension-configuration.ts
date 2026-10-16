import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import type { ExtensionSelectionEntry } from '@/app/lib/capabilities/extensions/contracts';
import { withAuthorizedCorePluginSource } from '@/app/lib/capabilities/extensions/core-source';
import { parseStoredCorePluginExtensionBinding, type StoredCorePluginExtensionBinding } from '@/app/lib/capabilities/extensions/stored-core-contracts';
import type { AgentManagementActor } from './management-actions';

export type PreparedAgentCorePlugin = { stored: StoredCorePluginExtensionBinding; skillNames: string[] };

export async function prepareAgentCorePluginConfigurations(actor: AgentManagementActor,
  selections: readonly ExtensionSelectionEntry[]): Promise<PreparedAgentCorePlugin[]> {
  const result: PreparedAgentCorePlugin[] = [];
  for (const entry of selections) {
    if (entry.selection.kind !== 'core_plugin') continue;
    const stored = parseStoredCorePluginExtensionBinding({ version: 2, kind: 'core_plugin', entry });
    const skillNames = await withAuthorizedCorePluginSource(actor, stored.entry.selection.coreSource,
      async plugin => plugin.skills.map(skill => skill.name));
    result.push({ stored, skillNames });
  }
  return result.sort((left, right) => left.stored.entry.selection.coreSource.resourceRef.localeCompare(right.stored.entry.selection.coreSource.resourceRef));
}

/** Core Use/hash checks use the actual caller lease before the Agent row lock. */
export async function withAgentCorePluginSources<T>(database: SqlConnection, actor: AgentManagementActor,
  sources: readonly StoredCorePluginExtensionBinding[], callback: () => Promise<T>): Promise<T> {
  const ordered = [...sources].sort((left, right) => left.entry.selection.coreSource.resourceRef.localeCompare(right.entry.selection.coreSource.resourceRef));
  const next = (index: number): Promise<T> => index === ordered.length ? callback()
    : withAuthorizedCorePluginSource(actor, ordered[index].entry.selection.coreSource, () => next(index + 1), { database });
  return next(0);
}
