import 'server-only';

import { createHash } from 'node:crypto';
import { EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS, renderEffectiveExtensionContext,
  type ExtensionContextPresentation, type RenderedExtensionContext } from '@/app/lib/capabilities/extensions/context-prompt';
import { intersectIntegrationPolicies, isIntegrationProviderOperationAllowed } from '@/app/lib/integration-tools/policy';
import { buildPiSpecialAgentRegistrationMetadata, type PiSpecialAgentRegistrationInput,
  type PiSpecialAgentRegistrationMetadata } from '@/app/lib/pi/tool-registry';
import type { EffectiveToolManifest } from '@/app/lib/pi/effective-tool-manifest';
import { resolveSpecialAgentRuntimeSettings, type SpecialAgentRuntimeFields } from './effective-runtime-config';
import { AgentWorkflowError } from './workflow-contracts';

export type AgentExtensionConfigurationCompilationInput = {
  actorUserId: string;
  runtimeFields: SpecialAgentRuntimeFields;
  workspacePermissions?: PiSpecialAgentRegistrationInput['workspacePermissions'];
  /** Source-checked metadata with a SHA256 source fingerprint; never runtime authority. */
  presentation: ExtensionContextPresentation;
  requiredProviders: readonly { source: 'mcp' | 'composio'; providerRef: string }[];
};
export type CompiledAgentExtensionConfigurationContext = Readonly<{
  fingerprint: string;
  registration: PiSpecialAgentRegistrationMetadata;
  rendered: RenderedExtensionContext;
}>;

function registered(manifest: EffectiveToolManifest, operation: string): boolean {
  return manifest.registeredToolNames.includes(operation) || manifest.gateways.some(gateway =>
    manifest.registeredToolNames.includes(gateway.toolName) && gateway.allowedOperationNames.includes(operation));
}

/**
 * Compile checked configuration metadata using actual inheritance and native
 * registration. Source/target authorization stays in the caller; this creates
 * no Agent, session, provider probe, read root or issued runtime selection.
 */
export async function compileAgentExtensionConfigurationContext(input: AgentExtensionConfigurationCompilationInput):
  Promise<CompiledAgentExtensionConfigurationContext> {
  const { actorUserId, runtimeFields, workspacePermissions, presentation, requiredProviders } = structuredClone(input);
  if (!/^[a-f0-9]{64}$/u.test(presentation.fingerprint)) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_INVALID', 'A checked configuration source fingerprint is required.', 400);
  }
  const settings = await resolveSpecialAgentRuntimeSettings(runtimeFields);
  const registration = await buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: actorUserId,
    effectiveEnabledTools: settings.enabledTools, extensionMode: presentation.mode === 'fixed' ? 'fixed' : 'legacy_inherit',
    workspacePermissions });
  const workflowProjection = presentation.workflowProjection;
  if ((presentation.packages.some(pkg => pkg.skills.length > 0) || presentation.corePackages?.some(pkg => pkg.skills.length > 0)
    || presentation.skills.some(skill => skill.required && !skill.core)) && !registered(registration.manifest, 'read')) {
    throw new AgentWorkflowError('AGENT_EXTENSION_READ_TOOL_REQUIRED',
      'Enable the skill reading tool before assigning these published skills.', 409);
  }
  if (requiredProviders.length > 0 && !workflowProjection?.unavailable) {
    const ceiling = registration.integrationPolicyCeiling;
    const policy = ceiling && workflowProjection ? intersectIntegrationPolicies(ceiling, workflowProjection.policy) : null;
    if (!registration.manifest.registeredToolNames.includes('integrations') || !policy
      || requiredProviders.some(provider => !isIntegrationProviderOperationAllowed(policy,
        provider.source, provider.providerRef, 'search_tools') || !isIntegrationProviderOperationAllowed(policy,
        provider.source, provider.providerRef, 'describe'))) {
      throw new AgentWorkflowError('AGENT_EXTENSION_DISCOVERY_TOOLS_REQUIRED',
        'Enable the tool search and schema tools needed by this required connection.', 409);
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([presentation.fingerprint,
    registration.manifest, registration.integrationPolicyCeiling])).digest('hex');
  // Each recipe repeats taskQuery. A lone UTF-16 surrogate requires six JSON
  // escape bytes, so reserve that maximum rather than a shorter sample query.
  // Actual Runtime rendering still ranks optional details for its real task.
  const reservedTaskQuery = '\ud800'.repeat(EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS);
  const rendered = renderEffectiveExtensionContext({ ...presentation, fingerprint }, registration.manifest, reservedTaskQuery,
    { integrationPolicyCeiling: registration.integrationPolicyCeiling ?? undefined });
  return Object.freeze({ fingerprint, registration, rendered });
}
