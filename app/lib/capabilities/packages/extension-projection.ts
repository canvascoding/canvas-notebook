import 'server-only';

import type { StoredAgentWorkflowPackage } from '@/app/lib/agents/workflow-contracts';
import { extensionSelectionEntrySchema, type ExtensionSelectionEntry } from '@/app/lib/capabilities/extensions/contracts';
import type { StoredPackageExtensionSelectionEntry } from '@/app/lib/capabilities/extensions/stored-package-contracts';
import { CapabilityPackageError } from './contracts';

export type PackageExtensionSkillIdentity = Readonly<{ name: string; relativeRoot: string }>;

function invalid(message: string): never {
  throw new CapabilityPackageError('PACKAGE_INVALID', message, 409);
}

/** A ceiling never widens an already selected connection, including an empty ceiling. */
export function intersectPackageExtensionToolCaps(...caps: readonly (readonly string[] | null)[]): string[] | null {
  let permitted: string[] | null = null;
  for (const cap of caps) if (cap !== null) {
    permitted = permitted === null ? [...cap] : permitted.filter(name => cap.includes(name));
  }
  return permitted;
}

/** Syntax is not authority: callers must supply the actual held manifest inventory and current policy roots. */
export function projectPackageExtensionSelection(input: {
  source: StoredAgentWorkflowPackage;
  kind: 'plugin' | 'skill';
  inventory: readonly PackageExtensionSkillIdentity[];
  selections?: readonly StoredPackageExtensionSelectionEntry[] | readonly ExtensionSelectionEntry[];
  requiredRoots?: readonly string[];
}): { configuration: StoredAgentWorkflowPackage; selectedRoots: readonly string[] } {
  const { source, inventory, kind } = input;
  const actual = new Map(inventory.map(skill => [skill.relativeRoot, skill]));
  if (actual.size !== inventory.length || new Set(inventory.map(skill => skill.name)).size !== inventory.length
    || source.selectedSkills.some(skill => actual.get(skill.relativeRoot)?.name !== skill.name)) {
    invalid('The held skill identities do not match the actual published package.');
  }
  // Existing V1 child-only declarations and selection semantics remain unchanged.
  if (input.selections === undefined) return { configuration: source, selectedRoots: source.selectedSkills.map(skill => skill.relativeRoot) };
  if (!input.selections.length) invalid('A fixed package needs an explicit selection.');
  const entries = input.selections.map(entry => extensionSelectionEntrySchema.parse(entry));
  const roots = new Set<string>();
  let parent: ExtensionSelectionEntry | undefined;
  const children = new Map<string, ExtensionSelectionEntry>();
  for (const entry of entries) {
    const selection = entry.selection;
    if (selection.kind !== 'plugin' && selection.kind !== 'skill') invalid('A package cannot bind a standalone connection.');
    if (selection.package.resourceRef !== source.resourceRef || selection.package.publishedRevisionRef !== source.publishedRevisionRef
      || selection.package.checksum !== source.checksum) invalid('A package selection changed its immutable source.');
    if (selection.kind === 'plugin') {
      if (kind !== 'plugin' || parent || source.skillSelection.kind !== 'plugin') invalid('The parent selection does not match this published plugin.');
      parent = entry;
      const selected = selection.skillSelection.kind === 'all' ? inventory.map(skill => skill.relativeRoot) : selection.skillSelection.relativeRoots;
      for (const root of selected) {
        if (!actual.has(root)) invalid('Choose an actual child root from the held plugin version.');
        roots.add(root);
      }
    } else {
      if (selection.origin !== (kind === 'plugin' ? 'plugin_child' : 'standalone') || !actual.has(selection.relativeRoot)
        || children.has(selection.relativeRoot)) invalid('The selected skill has a different actual package origin.');
      children.set(selection.relativeRoot, entry); roots.add(selection.relativeRoot);
    }
  }
  if (source.skillSelection.kind === 'plugin' && !parent) invalid('The selected plugin must retain its parent declaration scope.');
  if (source.skillSelection.kind === 'skills' && (roots.size !== source.selectedSkills.length
    || source.selectedSkills.some(skill => !roots.has(skill.relativeRoot)))) invalid('The child-only selection changed its stored roots.');
  for (const root of input.requiredRoots ?? []) {
    if (!actual.has(root)) invalid('A required skill is not in the held published package.');
    roots.add(root);
  }
  const byPath = new Map(inventory.map(skill => [skill.relativeRoot ? `${skill.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml', skill.relativeRoot]));
  const declarations = source.declarations.flatMap(declaration => {
    const isParent = declaration.declarationPath === '.canvas-plugin/plugin.json';
    const root = byPath.get(declaration.declarationPath);
    if (isParent ? !parent : root === undefined || !roots.has(root)) return [];
    const ceiling = intersectPackageExtensionToolCaps(parent?.toolCap ?? null, !isParent && root !== undefined ? children.get(root)?.toolCap ?? null : null);
    return [{ ...declaration, capabilities: declaration.capabilities.map(capability => {
      const selection = capability.selection;
      return { ...capability, selection: selection.mode === 'fixed'
        ? { ...selection, toolCap: intersectPackageExtensionToolCaps(selection.toolCap, ceiling) }
        : { ...selection, allowedChoices: selection.allowedChoices.map(choice => ({ ...choice,
          toolCap: intersectPackageExtensionToolCaps(choice.toolCap, ceiling) })),
        ...(selection.personalPolicy ? { personalPolicy: { ...selection.personalPolicy,
          toolCap: intersectPackageExtensionToolCaps(selection.personalPolicy.toolCap, ceiling) } } : {}) } };
    }) }];
  });
  const selectedSkills = inventory.filter(skill => roots.has(skill.relativeRoot)).map(skill => ({ name: skill.name, relativeRoot: skill.relativeRoot }));
  return { configuration: { ...source, selectedSkills, declarations }, selectedRoots: selectedSkills.map(skill => skill.relativeRoot) };
}

/** A turn may focus or tighten a fixed selection; it never adds a configured child or connection. */
export function applyPackageExtensionTurnFocus(configuration: StoredAgentWorkflowPackage, kind: 'plugin' | 'skill',
  entries: readonly ExtensionSelectionEntry[]): StoredAgentWorkflowPackage {
  const allowed = new Set(configuration.selectedSkills.map(skill => skill.relativeRoot));
  let parentCap: string[] | null = null;
  const children = new Map<string, string[] | null>();
  for (const entry of entries) {
    const selection = entry.selection;
    if (selection.kind !== 'plugin' && selection.kind !== 'skill') invalid('A package focus cannot bind another provider.');
    if (selection.package.resourceRef !== configuration.resourceRef || selection.package.publishedRevisionRef !== configuration.publishedRevisionRef
      || selection.package.checksum !== configuration.checksum) invalid('A turn cannot switch a configured immutable package pin.');
    if (selection.kind === 'plugin') {
      if (kind !== 'plugin' || configuration.skillSelection.kind !== 'plugin') invalid('A turn cannot expand a child-only configuration to its parent.');
      if (selection.skillSelection.kind === 'subset' && selection.skillSelection.relativeRoots.some(root => !allowed.has(root))) {
        invalid('A turn cannot add a child outside this fixed selection.');
      }
      parentCap = intersectPackageExtensionToolCaps(parentCap, entry.toolCap);
    } else {
      if (selection.origin !== (kind === 'plugin' ? 'plugin_child' : 'standalone') || !allowed.has(selection.relativeRoot)) {
        invalid('A turn cannot add another skill or package origin to this fixed selection.');
      }
      children.set(selection.relativeRoot, intersectPackageExtensionToolCaps(children.get(selection.relativeRoot) ?? null, entry.toolCap));
    }
  }
  const byPath = new Map(configuration.selectedSkills.map(skill => [skill.relativeRoot ? `${skill.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml', skill.relativeRoot]));
  return { ...configuration, declarations: configuration.declarations.map(declaration => {
    const root = byPath.get(declaration.declarationPath);
    const cap = intersectPackageExtensionToolCaps(parentCap, root === undefined ? null : children.get(root) ?? null);
    return { ...declaration, capabilities: declaration.capabilities.map(capability => ({ ...capability,
      selection: capability.selection.mode === 'fixed' ? { ...capability.selection,
        toolCap: intersectPackageExtensionToolCaps(capability.selection.toolCap, cap) } : { ...capability.selection,
        allowedChoices: capability.selection.allowedChoices.map(choice => ({ ...choice, toolCap: intersectPackageExtensionToolCaps(choice.toolCap, cap) })),
        ...(capability.selection.personalPolicy ? { personalPolicy: { ...capability.selection.personalPolicy,
          toolCap: intersectPackageExtensionToolCaps(capability.selection.personalPolicy.toolCap, cap) } } : {}) } })) };
  }) };
}
