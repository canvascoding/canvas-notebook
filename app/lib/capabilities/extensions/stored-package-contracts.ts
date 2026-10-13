import { z } from 'zod';
import {
  AgentWorkflowError,
  parseStoredAgentWorkflowPackage,
} from '@/app/lib/agents/workflow-contracts';
import {
  EXTENSION_SELECTION_LIMITS,
  extensionSelectionEntrySchema,
  extensionSelectionIdentity,
} from './contracts';
import { copyBoundedJson, freeze } from './stored-contracts';

const packageEntrySchema = extensionSelectionEntrySchema.transform((entry, context) => {
  if (entry.selection.kind !== 'plugin' && entry.selection.kind !== 'skill') {
    context.addIssue({ code: 'custom', message: 'Only exact plugin and skill selections belong in a package binding.' });
    return z.NEVER;
  }
  return { selection: entry.selection, requirement: entry.requirement, toolCap: entry.toolCap };
});
export type StoredPackageExtensionSelectionEntry = z.infer<typeof packageEntrySchema>;

const privateWorkflowSchema = z.unknown().transform((value, context) => {
  try {
    return parseStoredAgentWorkflowPackage(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'The existing private package workflow cannot be verified.' });
    return z.NEVER;
  }
});

const packageBindingSchema = z.object({
  version: z.literal(2),
  kind: z.literal('package'),
  workflow: privateWorkflowSchema,
  selections: z.array(packageEntrySchema).min(1).max(EXTENSION_SELECTION_LIMITS.agent),
}).strict().superRefine(({ workflow, selections }, context) => {
  const roots = new Set(workflow.selectedSkills.map(skill => skill.relativeRoot));
  const identities = new Set<string>();
  const childMask = new Set<string>();
  const plugins = selections.filter(entry => entry.selection.kind === 'plugin');
  if (plugins.length > 1 || workflow.skillSelection.kind === 'plugin' && plugins.length !== 1) {
    context.addIssue({ code: 'custom', message: 'A complete plugin workflow requires exactly one explicit parent selection.' });
  }
  for (const entry of selections) {
    const selection = entry.selection;
    const identity = extensionSelectionIdentity(selection);
    if (identities.has(identity)) {
      context.addIssue({ code: 'custom', message: 'Duplicate exact package or skill selections are not allowed.' });
    }
    identities.add(identity);
    const pin = selection.package;
    if (pin.resourceRef !== workflow.resourceRef || pin.publishedRevisionRef !== workflow.publishedRevisionRef
      || pin.checksum !== workflow.checksum) {
      context.addIssue({ code: 'custom', message: 'Every selection must preserve the exact private immutable package pin.' });
    }
    if (selection.kind === 'plugin') {
      if (workflow.skillSelection.kind !== 'plugin' || workflow.childRelativeRoot !== undefined) {
        context.addIssue({ code: 'custom', message: 'A plugin selection must retain its parent workflow scope.' });
      }
      if (selection.skillSelection.kind === 'all') {
        for (const root of roots) childMask.add(root);
      } else {
        for (const root of selection.skillSelection.relativeRoots) {
          if (!roots.has(root)) context.addIssue({ code: 'custom', message: 'A plugin subset must name actual selected skill roots.' });
          childMask.add(root);
        }
      }
      continue;
    }
    if (!roots.has(selection.relativeRoot)) {
      context.addIssue({ code: 'custom', message: 'An individual skill must name an exact root in the private workflow.' });
    }
    childMask.add(selection.relativeRoot);
    if (workflow.skillSelection.kind === 'plugin' && selection.origin !== 'plugin_child') {
      context.addIssue({ code: 'custom', message: 'A skill selected alongside its plugin must preserve its parent origin.' });
    }
    if (selection.origin === 'standalone' && (workflow.skillSelection.kind !== 'skills'
      || workflow.selectedSkills.length !== 1 || selection.relativeRoot !== '' || workflow.childRelativeRoot !== undefined)) {
      context.addIssue({ code: 'custom', message: 'A standalone skill has one package-root workflow and no plugin-child marker.' });
    }
  }
  if (workflow.skillSelection.kind === 'skills' && (childMask.size !== roots.size
    || [...roots].some(root => !childMask.has(root)))) {
    context.addIssue({ code: 'custom', message: 'A child-only workflow must preserve exactly its explicit skill selections.' });
  }
  if (workflow.childRelativeRoot !== undefined && (workflow.selectedSkills.length !== 1
    || !selections.every(entry => entry.selection.kind === 'skill' && entry.selection.origin === 'plugin_child'
      && entry.selection.relativeRoot === workflow.childRelativeRoot))) {
    context.addIssue({ code: 'custom', message: 'The private child marker must match one exact plugin-child selection.' });
  }
  // childMask is validation only. Keep the full V1 workflow and declarations:
  // the authorized V2 runtime projection applies the union mask and parent rules.
});

/** Private syntax only; parsing does not prove an immutable source, current use rights or a runtime proof. */
export const storedPackageExtensionBindingSchema = z.preprocess((value, context) => {
  try {
    return copyBoundedJson(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'A bounded private JSON package binding is required.' });
    return z.NEVER;
  }
}, packageBindingSchema).transform(value => freeze(value));
export type StoredPackageExtensionBinding = z.infer<typeof storedPackageExtensionBindingSchema>;

export function parseStoredPackageExtensionBinding(value: unknown): StoredPackageExtensionBinding {
  const parsed = storedPackageExtensionBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored package extension binding cannot be verified.', 409);
  }
  return parsed.data;
}
