import { agentExtensionConfigurationInputSchema, type AgentExtensionConfigurationInput, type ExtensionPackagePin, type ExtensionSelectionInput } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionPackageVersion } from '@/app/lib/agents/extension-options-contracts';
import type { AgentWorkflowPackageConfiguration } from '@/app/lib/agents/workflow-public-contracts';
import type { WorkflowDeclaration, WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import type { AgentExtensionEditorDraft } from './AgentExtensionEditor';

export type FixedAgentExtensionConfiguration = Extract<AgentExtensionConfigurationInput, { mode: 'fixed' }>;
export const extensionPinKey = (pin: ExtensionPackagePin) => JSON.stringify([pin.resourceRef, pin.publishedRevisionRef, pin.checksum]);
export const extensionAlternativeKey = (alternative: WorkflowIntegrationAlternative) => `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`;
export const emptyAgentExtensionConfiguration = (): FixedAgentExtensionConfiguration => ({ version: 1, origin: 'agent_configuration',
  mode: 'fixed', selections: [], workflow: { version: 1, packages: [] }, standalone: [] });

export function selectedExtensionRoots(configuration: FixedAgentExtensionConfiguration, metadata: AgentExtensionPackageVersion): string[] {
  const entries = configuration.selections.filter(entry => (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
    && extensionPinKey(entry.selection.package) === extensionPinKey(metadata.pin));
  const roots = new Set(metadata.children.filter(child => child.required).map(child => child.relativeRoot));
  for (const { selection } of entries) {
    if (selection.kind === 'plugin') (selection.skillSelection.kind === 'all' ? metadata.children.map(child => child.relativeRoot) : selection.skillSelection.relativeRoots).forEach(root => roots.add(root));
    else if (selection.kind === 'skill') roots.add(selection.relativeRoot);
  }
  return [...roots];
}
export function activeExtensionDeclarations(configuration: FixedAgentExtensionConfiguration, metadata: AgentExtensionPackageVersion): WorkflowDeclaration[] {
  const roots = new Set(selectedExtensionRoots(configuration, metadata));
  return metadata.declarations.filter(declaration => declaration.declarationPath === '.canvas-plugin/plugin.json'
    || metadata.children.some(child => roots.has(child.relativeRoot) && declaration.declarationPath === (child.relativeRoot ? `${child.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml')));
}
export function addExtensionPackage(configuration: FixedAgentExtensionConfiguration, metadata: AgentExtensionPackageVersion,
  selection?: ExtensionSelectionInput['selection']): FixedAgentExtensionConfiguration {
  const next = structuredClone(configuration), exact = selection && (selection.kind === 'plugin' || selection.kind === 'skill')
    && extensionPinKey(selection.package) === extensionPinKey(metadata.pin) ? selection : metadata.kind === 'plugin'
      ? { kind: 'plugin' as const, package: metadata.pin, skillSelection: { kind: 'all' as const } }
      : { kind: 'skill' as const, package: metadata.pin, origin: 'standalone' as const, relativeRoot: '' };
  const previous = next.workflow?.packages.find(pkg => pkg.resourceRef === metadata.pin.resourceRef);
  if (previous && extensionPinKey(previous) !== extensionPinKey(metadata.pin)) throw new Error('Remove the currently selected package version before adding another version.');
  if (!next.selections.some(entry => JSON.stringify(entry.selection) === JSON.stringify(exact))) next.selections.push({ selection: exact, requirement: 'optional', toolCap: null });
  const parent = next.selections.some(entry => entry.selection.kind === 'plugin' && entry.selection.package.resourceRef === metadata.pin.resourceRef);
  const pkg: AgentWorkflowPackageConfiguration = previous ?? { ...metadata.pin, declarations: [], skillSelection: parent
    ? { kind: 'plugin' } : { kind: 'skills', relativeRoots: next.selections.flatMap(entry => entry.selection.kind === 'skill'
      && entry.selection.package.resourceRef === metadata.pin.resourceRef ? [entry.selection.relativeRoot] : []) } };
  pkg.skillSelection = parent ? { kind: 'plugin' } : { kind: 'skills', relativeRoots: next.selections.flatMap(entry => entry.selection.kind === 'skill'
    && entry.selection.package.resourceRef === metadata.pin.resourceRef ? [entry.selection.relativeRoot] : []) };
  next.workflow = { version: 1, packages: [...(next.workflow?.packages ?? []).filter(value => value.resourceRef !== metadata.pin.resourceRef), pkg] };
  return next;
}

const DRAFT_PREFIX = 'canvas-agent-extension-draft:v1:';
type DisplayDraftRead = { draft: AgentExtensionEditorDraft; requiresAccountReselection: boolean };
function receiptOnlyIssues(issues: readonly { code: string; path?: PropertyKey[]; errors?: unknown }[]): boolean {
  return issues.length > 0 && issues.every(issue => issue.code === 'custom' && issue.path?.at(-1) === 'accountSelectionRef'
    || issue.code === 'invalid_union' && Array.isArray(issue.errors) && issue.errors.some(branch => Array.isArray(branch) && receiptOnlyIssues(branch)));
}
function isDisplayDraft(value: unknown): value is AgentExtensionEditorDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as AgentExtensionEditorDraft;
  if (Object.keys(draft).some(key => !['intent', 'configuration'].includes(key)) || !['keep', 'replace'].includes(draft.intent)) return false;
  if (draft.configuration === null) return draft.intent === 'keep';
  const parsed = agentExtensionConfigurationInputSchema.safeParse(draft.configuration);
  return parsed.success || receiptOnlyIssues(parsed.error.issues);
}
function draftStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
/** Receipts are short-lived intake data. Durable browser drafts deliberately cannot claim account validity. */
export function sanitizeAgentExtensionDraft(draft: AgentExtensionEditorDraft): { draft: AgentExtensionEditorDraft; requiresAccountReselection: boolean } {
  const copy = structuredClone(draft); let requiresAccountReselection = false;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = value as Record<string, unknown>;
    if ('accountSelectionRef' in row) { delete row.accountSelectionRef; requiresAccountReselection = true; }
    Object.values(row).forEach(visit);
  };
  visit(copy);
  return { draft: copy, requiresAccountReselection };
}
export function saveAgentExtensionDraft(key: string, draft: AgentExtensionEditorDraft): void {
  if (!isDisplayDraft(draft)) return;
  const sanitized = sanitizeAgentExtensionDraft(draft);
  const encoded = JSON.stringify({ version: 1, namespace: key, savedAt: Date.now(), ...sanitized,
    requiresAccountReselection: sanitized.requiresAccountReselection || readAgentExtensionDraft(key)?.requiresAccountReselection === true });
  if (new TextEncoder().encode(encoded).byteLength > 1_050_000) return;
  try { draftStorage()?.setItem(DRAFT_PREFIX + key, encoded); } catch { /* Storage is optional; the active form remains in memory. */ }
}
export function clearAgentExtensionDraft(key: string): void {
  try { draftStorage()?.removeItem(DRAFT_PREFIX + key); } catch { /* Storage may be unavailable. */ }
}
export function readAgentExtensionDraft(key: string): DisplayDraftRead | null {
  try {
    const raw = draftStorage()?.getItem(DRAFT_PREFIX + key); if (!raw || new TextEncoder().encode(raw).byteLength > 1_050_000) return null;
    const value = JSON.parse(raw) as { version?: number; namespace?: string; savedAt?: number; draft?: AgentExtensionEditorDraft; requiresAccountReselection?: boolean };
    if (value.version !== 1 || value.namespace !== key || typeof value.savedAt !== 'number' || !Number.isSafeInteger(value.savedAt)
      || value.savedAt > Date.now() + 5 * 60_000 || Date.now() - value.savedAt > 7 * 86_400_000 || !isDisplayDraft(value.draft)) return null;
    return sanitizeAgentExtensionDraft(value.draft).requiresAccountReselection
      ? null : { draft: value.draft, requiresAccountReselection: value.requiresAccountReselection === true };
  } catch { return null; }
}
