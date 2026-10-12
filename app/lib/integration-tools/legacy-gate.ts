import 'server-only';

import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { IntegrationContractError } from './contracts';
import { UNRESTRICTED_INTEGRATION_POLICY } from './policy';

/** Old wrappers cannot substitute defaults for an agent's concrete workflow connections. */
export async function assertLegacyIntegrationEntryPointAllowed(): Promise<void> {
  const context = getAgentExecutionContext();
  if (!context) return;
  const { resolveRuntimeIntegrationExecutionContext } = await import('./context');
  const { resolveIntegrationRuntimePolicy } = await import('./runtime-policy');
  const resolved = await resolveRuntimeIntegrationExecutionContext({ executionContext: { ...context }, policyRevision: 'legacy-integration-check' });
  const runtime = await resolveIntegrationRuntimePolicy({ executionContext: resolved.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
  if (runtime.policy.providerToolRules != null) {
    throw new IntegrationContractError('tool_denied', 'Use the integrations tool with this agent’s approved workflow connection.');
  }
}
