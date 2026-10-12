import type { AgentWorkflowPackageConfiguration, AgentWorkflowSelection, AgentWorkflowTarget } from '@/app/lib/agents/workflow-contracts';
import type { WorkflowDeclaration, WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import type { AgentWorkflowManagement, AgentWorkflowManagementPackageVersion } from '@/app/lib/agents/workflow-management-contracts';
import type { AgentWorkflowManagementSaveInput } from './agent-workflow-management-client';

export type WorkflowDraftChoice = { choiceId: string; alternativeKey: string; toolCap: string[] | null; target: AgentWorkflowTarget | null };
export type WorkflowDraftSelection = { mode: 'fixed'; alternativeKey: string; toolCap: string[] | null; target: AgentWorkflowTarget | null }
  | { mode: 'selectable'; allowedChoices: WorkflowDraftChoice[]; defaultChoiceId?: string;
    personalPolicy?: Extract<AgentWorkflowSelection, { mode: 'selectable' }>['personalPolicy'] };
export type WorkflowDraftCapability = { capabilityId: string; required: boolean; selection: WorkflowDraftSelection | null };
export type WorkflowDraftDeclaration = { declarationPath: string; capabilities: WorkflowDraftCapability[] };
export type WorkflowDraftPackage = Omit<AgentWorkflowPackageConfiguration, 'declarations'> & { declarations: WorkflowDraftDeclaration[] };
export type WorkflowDraftSlot = { resourceRef: string; declarationPath: string; capabilityId: string };
export type AgentWorkflowManagementDraft = { base: AgentWorkflowManagement; workflowIntent: 'keep' | 'replace' | 'clear';
  packages: WorkflowDraftPackage[]; packageVersions: Record<string, AgentWorkflowManagementPackageVersion> };
export type AgentWorkflowDraftBuildResult = { valid: true; input: AgentWorkflowManagementSaveInput }
  | { valid: false; issues: string[] };

function clone<T>(value: T): T { return structuredClone(value); }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function key(alternative: WorkflowIntegrationAlternative): string {
  return `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`;
}
function samePin(left: { resourceRef: string; publishedRevisionRef: string; checksum: string }, right: typeof left): boolean {
  return left.resourceRef === right.resourceRef && left.publishedRevisionRef === right.publishedRevisionRef && left.checksum === right.checksum;
}
function draftPackage(pkg: AgentWorkflowPackageConfiguration): WorkflowDraftPackage {
  return { ...clone(pkg), declarations: pkg.declarations.map(declaration => ({ declarationPath: declaration.declarationPath,
    capabilities: declaration.capabilities.map(capability => ({ capabilityId: capability.capabilityId, required: capability.required === true,
      selection: clone(capability.selection) })) })) };
}
export function createAgentWorkflowManagementDraft(snapshot: AgentWorkflowManagement): AgentWorkflowManagementDraft {
  return { base: clone(snapshot), workflowIntent: 'keep', packages: (snapshot.configuration?.packages ?? []).map(draftPackage), packageVersions: {} };
}
/** Mirrors the server's selected-root boundary; selecting children does not add the parent declaration. */
export function deriveActiveWorkflowDeclarations(version: AgentWorkflowManagementPackageVersion,
  selection: AgentWorkflowPackageConfiguration['skillSelection']): WorkflowDeclaration[] {
  if (selection.kind === 'plugin' && version.kind !== 'plugin') return [];
  const roots = selection.kind === 'plugin' ? version.skillRoots.map(skill => skill.relativeRoot) : selection.relativeRoots;
  if (new Set(roots).size !== roots.length || roots.some(root => version.skillRoots.filter(skill => skill.relativeRoot === root).length !== 1)) return [];
  const paths = new Set(roots.map(root => root ? `${root}/agents/canvas.yaml` : 'agents/canvas.yaml'));
  if (selection.kind === 'plugin') paths.add('.canvas-plugin/plugin.json');
  return clone(version.declarations.filter(declaration => paths.has(declaration.declarationPath)));
}
/** An explicit new pin starts with unbound capability slots. It never picks a connection or carries an old approval into a new version. */
export function applyWorkflowPackageVersion(draft: AgentWorkflowManagementDraft, version: AgentWorkflowManagementPackageVersion,
  selection: AgentWorkflowPackageConfiguration['skillSelection']): AgentWorkflowManagementDraft {
  const next = clone(draft);
  if (version.agentId !== next.base.agentId || version.revision !== next.base.revision || version.workflowRevision !== next.base.workflowRevision) return next;
  const previous = next.packages.find(pkg => pkg.resourceRef === version.resourceRef);
  const unchangedPin = previous && samePin(previous, version);
  const declarations = deriveActiveWorkflowDeclarations(version, selection).map(declaration => ({ declarationPath: declaration.declarationPath,
    capabilities: declaration.workflow.integrationCapabilities.map(capability => {
      const existing = unchangedPin ? previous.declarations.find(item => item.declarationPath === declaration.declarationPath)
        ?.capabilities.find(item => item.capabilityId === capability.id) : undefined;
      return { capabilityId: capability.id, required: capability.required || existing?.required === true,
        selection: existing?.selection ? clone(existing.selection) : null };
    }) }));
  const pkg: WorkflowDraftPackage = { resourceRef: version.resourceRef, publishedRevisionRef: version.publishedRevisionRef, checksum: version.checksum,
    skillSelection: clone(selection), ...(unchangedPin && previous.childRelativeRoot !== undefined && selection.kind === 'skills'
      && selection.relativeRoots.length === 1 && selection.relativeRoots[0] === previous.childRelativeRoot ? { childRelativeRoot: previous.childRelativeRoot } : {}), declarations };
  const index = next.packages.findIndex(item => item.resourceRef === pkg.resourceRef);
  if (index < 0) next.packages.push(pkg); else next.packages[index] = pkg;
  next.packageVersions[pkg.resourceRef] = clone(version); next.workflowIntent = 'replace';
  return next;
}
export function setWorkflowCapabilitySelection(draft: AgentWorkflowManagementDraft, slot: WorkflowDraftSlot,
  selection: WorkflowDraftSelection | null): AgentWorkflowManagementDraft {
  const next = clone(draft), capability = next.packages.find(pkg => pkg.resourceRef === slot.resourceRef)?.declarations
    .find(declaration => declaration.declarationPath === slot.declarationPath)?.capabilities.find(item => item.capabilityId === slot.capabilityId);
  if (capability) {
    capability.selection = clone(selection); next.workflowIntent = 'replace';
    const pkg = next.packages.find(item => item.resourceRef === slot.resourceRef)!;
    const declaration = pkg.declarations.find(item => item.declarationPath === slot.declarationPath)!;
    const choices = capability.selection?.mode === 'fixed' ? [capability.selection] : capability.selection?.allowedChoices ?? [];
    for (const choice of choices) if (!retainedValid(next, pkg, declaration, capability, choice)) choice.target = null;
  }
  return next;
}
export function removeWorkflowPackage(draft: AgentWorkflowManagementDraft, resourceRef: string): AgentWorkflowManagementDraft {
  const next = clone(draft); next.packages = next.packages.filter(pkg => pkg.resourceRef !== resourceRef);
  delete next.packageVersions[resourceRef]; next.workflowIntent = 'replace'; return next;
}
export function isAgentWorkflowManagementDraftDirty(draft: AgentWorkflowManagementDraft): boolean {
  return draft.workflowIntent === 'clear' ? draft.base.workflowVersion !== null : draft.workflowIntent === 'replace'
    && (draft.base.configurationState === 'blocked' || draft.base.workflowVersion !== 1
      || !equal(draft.packages, (draft.base.configuration?.packages ?? []).map(draftPackage)));
}
function retainedValid(draft: AgentWorkflowManagementDraft, pkg: WorkflowDraftPackage, declaration: WorkflowDraftDeclaration,
  capability: WorkflowDraftCapability, choice: { alternativeKey: string; target: AgentWorkflowTarget | null; choiceId?: string }): boolean {
  if (choice.target?.kind !== 'retained') return true;
  const original = draft.base.configuration?.packages.find(item => samePin(item, pkg))?.declarations
    .find(item => item.declarationPath === declaration.declarationPath)?.capabilities.find(item => item.capabilityId === capability.capabilityId)?.selection;
  if (!original || original.mode !== capability.selection?.mode) return false;
  const old = original.mode === 'fixed' ? choice.choiceId === undefined ? original : undefined
    : original.allowedChoices.find(item => item.choiceId === choice.choiceId);
  return Boolean(old && old.alternativeKey === choice.alternativeKey && equal(old.target, choice.target));
}
function validTarget(target: AgentWorkflowTarget | null): target is AgentWorkflowTarget {
  if (!target) return false;
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  if (target.kind === 'retained') return /^agent-workflow-retain:v1:[a-f0-9]{64}$/u.test(target.retainedBindingRef)
    && Object.keys(target).every(field => ['kind', 'retainedBindingRef'].includes(field));
  if (target.kind === 'shared') return new RegExp(`^canvas-connection:${uuid}$`, 'u').test(target.connectionRef)
    && Number.isSafeInteger(target.bindingRevision) && target.bindingRevision > 0
    && ['mcp', 'composio'].includes(target.source) && Object.keys(target).every(field => ['kind', 'source', 'connectionRef', 'bindingRevision', 'mcpMapping'].includes(field))
    && (target.mcpMapping === undefined || target.source === 'mcp' && target.mcpMapping.kind === 'manager_confirmation'
      && Object.keys(target.mcpMapping).length === 1);
  return target.kind === 'personal' && ['mcp', 'composio'].includes(target.source) && bounded(target.ownerUserId) && bounded(target.providerRef)
    && (target.accountSelectionRef === undefined || typeof target.accountSelectionRef === 'string' && target.accountSelectionRef.length > 0 && target.accountSelectionRef.length <= 8192)
    && Object.keys(target).every(field => ['kind', 'source', 'ownerUserId', 'providerRef', 'accountSelectionRef'].includes(field));
}
function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validCap(cap: string[] | null, required: readonly string[]): boolean {
  return cap === null || Array.isArray(cap) && cap.length <= 256 && cap.every(bounded) && new Set(cap).size === cap.length && required.every(name => cap.includes(name));
}
/** Client-side completeness only. Current rights, provider readiness and all CAS remain server-authoritative. */
export function buildAgentWorkflowConfigurationPayload(draft: AgentWorkflowManagementDraft): AgentWorkflowDraftBuildResult {
  const issues: string[] = [];
  const problem = (code: string, ...slot: string[]) => { issues.push([code, ...slot].join('|')); };
  if (!draft.base.access.canEdit) problem('access_denied');
  if (draft.base.configurationState === 'blocked' && draft.workflowIntent === 'keep') problem('configuration_blocked');
  if (!isAgentWorkflowManagementDraftDirty(draft)) problem('no_changes');
  if (draft.packages.length > 32 || new Set(draft.packages.map(pkg => pkg.resourceRef)).size !== draft.packages.length) problem('invalid_packages');
  const packages: AgentWorkflowPackageConfiguration[] = [];
  if (draft.workflowIntent === 'replace') for (const pkg of draft.packages) {
    const original = draft.base.configuration?.packages.find(item => samePin(item, pkg)), version = draft.packageVersions[pkg.resourceRef];
    if (!version && original && equal(draftPackage(original), pkg)) { packages.push(clone(original)); continue; }
    if (!version || !samePin(pkg, version) || version.agentId !== draft.base.agentId || version.revision !== draft.base.revision
      || version.workflowRevision !== draft.base.workflowRevision) { problem('missing_version', pkg.resourceRef); continue; }
    if (pkg.skillSelection.kind === 'plugin' && version.kind !== 'plugin' || pkg.skillSelection.kind === 'skills'
      && (!pkg.skillSelection.relativeRoots.length || new Set(pkg.skillSelection.relativeRoots).size !== pkg.skillSelection.relativeRoots.length
        || pkg.skillSelection.relativeRoots.length > 128 || pkg.skillSelection.relativeRoots.some(root => version.skillRoots.filter(skill => skill.relativeRoot === root).length !== 1))
      || pkg.childRelativeRoot !== undefined && (pkg.skillSelection.kind !== 'skills' || pkg.skillSelection.relativeRoots.length !== 1
        || pkg.skillSelection.relativeRoots[0] !== pkg.childRelativeRoot)) {
      problem('invalid_roots', pkg.resourceRef); continue;
    }
    const active = deriveActiveWorkflowDeclarations(version, pkg.skillSelection);
    if (pkg.declarations.length > 128 || new Set(pkg.declarations.map(item => item.declarationPath)).size !== pkg.declarations.length
      || pkg.declarations.some(item => !active.some(value => value.declarationPath === item.declarationPath))) problem('invalid_declarations', pkg.resourceRef);
    const declarations: AgentWorkflowPackageConfiguration['declarations'] = [];
    for (const definition of active) {
      const declaration = pkg.declarations.find(item => item.declarationPath === definition.declarationPath);
      if (!declaration) { if (definition.workflow.integrationCapabilities.some(capability => capability.required)) problem('required_binding', pkg.resourceRef, definition.declarationPath); continue; }
      if (declaration.capabilities.length > 128 || new Set(declaration.capabilities.map(item => item.capabilityId)).size !== declaration.capabilities.length
        || declaration.capabilities.some(item => !definition.workflow.integrationCapabilities.some(value => value.id === item.capabilityId))) {
        problem('invalid_capabilities', pkg.resourceRef, declaration.declarationPath);
      }
      const capabilities: AgentWorkflowPackageConfiguration['declarations'][number]['capabilities'] = [];
      for (const portable of definition.workflow.integrationCapabilities) {
        const capability = declaration.capabilities.find(item => item.capabilityId === portable.id), selection = capability?.selection;
        if (!capability || !selection) { if (portable.required || capability?.required) problem('required_binding', pkg.resourceRef, declaration.declarationPath, portable.id); continue; }
        if (portable.required && !capability.required) problem('required_downgrade', pkg.resourceRef, declaration.declarationPath, portable.id);
        const choices = selection.mode === 'fixed' ? [selection] : selection.allowedChoices;
        if (selection.mode === 'selectable' && (choices.length > 32 || new Set(selection.allowedChoices.map(choice => choice.choiceId)).size !== choices.length
          || selection.allowedChoices.some(choice => !bounded(choice.choiceId))
          || selection.defaultChoiceId !== undefined && !selection.allowedChoices.some(choice => choice.choiceId === selection.defaultChoiceId))) problem('invalid_choices', pkg.resourceRef, portable.id);
        for (const choice of choices) {
          const alternative = portable.alternatives.find(value => key(value) === choice.alternativeKey);
          if (!alternative || !validTarget(choice.target) || choice.target.kind !== 'retained' && choice.target.source !== alternative.source
            || draft.base.profile.scopeType === 'organization' && choice.target.kind === 'personal') problem('invalid_target', pkg.resourceRef, portable.id);
          if (!validCap(choice.toolCap, alternative?.requiredTools ?? [])) problem('required_tool_cap', pkg.resourceRef, portable.id);
          if (!retainedValid(draft, pkg, declaration, capability, choice)) problem('retained_target_changed', pkg.resourceRef, portable.id);
        }
        if (selection.mode === 'selectable' && selection.personalPolicy) {
          const policy = selection.personalPolicy;
          if (!policy.sources.length || new Set(policy.sources).size !== policy.sources.length || policy.sources.some(source => !['mcp', 'composio'].includes(source))
            || !policy.alternativeKeys.length || new Set(policy.alternativeKeys).size !== policy.alternativeKeys.length
            || policy.alternativeKeys.some(name => !portable.alternatives.some(value => key(value) === name && policy.sources.includes(value.source)))
            || !validCap(policy.toolCap, [])) problem('invalid_personal_policy', pkg.resourceRef, portable.id);
          for (const name of policy.alternativeKeys) {
            const alternative = portable.alternatives.find(value => key(value) === name);
            if (alternative?.source === 'mcp' && !policy.mcpDefinitionMappings?.some(mapping => mapping.connector === alternative.connector
              && mapping.serverDefinitionIds.length > 0 && mapping.serverDefinitionIds.every(bounded))) problem('missing_mcp_mapping', pkg.resourceRef, portable.id);
          }
        }
        capabilities.push({ capabilityId: capability.capabilityId, required: portable.required || capability.required,
          selection: clone(selection) as AgentWorkflowSelection });
      }
      declarations.push({ declarationPath: declaration.declarationPath, capabilities });
    }
    packages.push({ resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum,
      skillSelection: clone(pkg.skillSelection), ...(pkg.childRelativeRoot === undefined ? {} : { childRelativeRoot: pkg.childRelativeRoot }), declarations });
  }
  if (issues.length) return { valid: false, issues: [...new Set(issues)] };
  return { valid: true, input: { agentId: draft.base.agentId, expectedRevision: draft.base.revision, expectedWorkflowRevision: draft.base.workflowRevision,
    ...(draft.workflowIntent === 'clear' ? { workflow: null } : draft.workflowIntent === 'replace' ? { workflow: { version: 1, packages } } : {}) } };
}
