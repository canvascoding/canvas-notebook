import { extensionSelectionIdentity, type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { PluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';

/** Optional current display metadata, never selection or execution authority. No account labels are inferred. */
export type AgentExtensionStandaloneSummary = {
  configurationId: string;
  choiceId?: string;
  selection: StandaloneExtensionSelection;
  label: string;
  scopeLabel: 'personal' | 'organization' | 'team' | 'system';
  profileLabel?: string;
  icon?: PluginExtensionIcon;
};

/** Include the held shared revision, unlike the semantic duplicate-selection key. */
export function agentExtensionStandalonePresentationKey(selection: StandaloneExtensionSelection): string {
  return JSON.stringify([extensionSelectionIdentity(selection), selection.target.kind === 'shared' ? selection.target.bindingRevision : null]);
}
