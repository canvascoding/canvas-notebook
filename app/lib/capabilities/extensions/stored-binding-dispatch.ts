import { AgentWorkflowError, parseStoredAgentWorkflowPackage, type StoredAgentWorkflowPackage } from '@/app/lib/agents/workflow-contracts';
import type { AgentWorkflowVersion } from '@/app/lib/agents/workflow-version';
import { EXTENSION_SELECTION_LIMITS } from './contracts';
import { parseStoredStandaloneExtensionBinding, type StoredStandaloneExtensionBinding } from './stored-contracts';
import { parseStoredPackageExtensionBinding, type StoredPackageExtensionSelectionEntry } from './stored-package-contracts';
import { createStandaloneExtensionSlotRef } from './standalone-reference';
import { parseStoredCoreExtensionBinding, type StoredCoreExtensionBinding } from './stored-core-contracts';

export type DecodedAgentExtensionBinding = {
  configuration: StoredAgentWorkflowPackage | null;
  extensionSelections?: StoredPackageExtensionSelectionEntry[];
  standaloneConfiguration?: StoredStandaloneExtensionBinding;
  coreConfiguration?: StoredCoreExtensionBinding;
  /** Aggregate format, independent of the nested V1 package/connection codec. */
  extensionFormatVersion: 1 | 2 | null;
};

function corrupt(): never {
  throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored extension configuration cannot be verified.', 409);
}

/** Decode private SQL bytes only. This proves neither actor access nor current resource use. */
export function decodeStoredAgentExtensionBinding(resourceType: unknown, encoded: unknown): DecodedAgentExtensionBinding {
  if (typeof resourceType !== 'string' || !['plugin', 'skill', 'connection'].includes(resourceType)) return corrupt();
  if (encoded === null) return { configuration: null, extensionFormatVersion: null };
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > EXTENSION_SELECTION_LIMITS.bytes) return corrupt();
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return corrupt(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return corrupt();
  if (Reflect.get(value, 'kind') === 'core_plugin' || Reflect.get(value, 'kind') === 'core_skill') {
    const coreConfiguration = parseStoredCoreExtensionBinding(value);
    if (resourceType !== (coreConfiguration.kind === 'core_plugin' ? 'plugin' : 'skill')) return corrupt();
    return { configuration: null, coreConfiguration, extensionFormatVersion: 2 };
  }
  if (resourceType === 'connection') {
    const standaloneConfiguration = parseStoredStandaloneExtensionBinding(value);
    return { configuration: null, standaloneConfiguration, extensionFormatVersion: 2 };
  }
  if (Reflect.get(value, 'version') === 2) {
    const wrapper = parseStoredPackageExtensionBinding(value);
    if (resourceType === 'skill' && wrapper.selections.some(entry => entry.selection.kind === 'plugin')) return corrupt();
    return { configuration: wrapper.workflow, extensionSelections: wrapper.selections, extensionFormatVersion: 2 };
  }
  return { configuration: parseStoredAgentWorkflowPackage(value), extensionFormatVersion: 1 };
}

/** All rows must match one explicit header; SQL NULL is the only inheritance marker. */
export function assertStoredAgentExtensionBindingsMatchHeader(version: AgentWorkflowVersion,
  bindings: readonly (DecodedAgentExtensionBinding & { resourceType: 'plugin' | 'skill' | 'connection'; resourceId: string })[]): void {
  if (version !== null && version !== 1 && version !== 2) return corrupt();
  const packageRefs = new Set<string>(), slots = new Set<string>();
  for (const binding of bindings) {
    if (version === null) {
      if (binding.extensionFormatVersion !== null) return corrupt();
      continue;
    }
    if (version === 1) {
      if (binding.resourceType === 'connection' ? binding.extensionFormatVersion !== null : binding.extensionFormatVersion !== 1) return corrupt();
    } else if (version === 2) {
      if (binding.extensionFormatVersion !== 2) return corrupt();
      if (binding.resourceType === 'connection') {
        const standalone = binding.standaloneConfiguration;
        if (!standalone) return corrupt();
        const source = standalone.mode === 'fixed' ? standalone.entry.selection.source : standalone.source;
        const toolkit = standalone.mode === 'fixed'
          ? standalone.entry.selection.kind === 'composio' ? standalone.entry.selection.toolkit : undefined : standalone.toolkit;
        const slot = createStandaloneExtensionSlotRef({ configurationId: standalone.configurationId, source, ...(toolkit ? { toolkit } : {}) });
        if (binding.resourceId !== slot || slots.has(standalone.configurationId)) return corrupt();
        slots.add(standalone.configurationId);
      } else if (binding.coreConfiguration) {
        const source = binding.coreConfiguration.entry.selection.coreSource;
        if (binding.resourceType !== (binding.coreConfiguration.kind === 'core_plugin' ? 'plugin' : 'skill')
          || binding.resourceId !== source.resourceRef || packageRefs.has(source.resourceRef)) return corrupt();
        packageRefs.add(source.resourceRef);
      } else if (!binding.configuration || !binding.extensionSelections) return corrupt();
    } else return corrupt();
    if (binding.configuration) {
      if (packageRefs.has(binding.configuration.resourceRef)) return corrupt();
      packageRefs.add(binding.configuration.resourceRef);
    }
  }
}
