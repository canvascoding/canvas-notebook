import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core';
import type { IntegrationErrorCode, IntegrationErrorResult } from './contracts';

export const INTEGRATION_GATEWAY_ERROR_MESSAGES: Record<IntegrationErrorCode, string> = {
  invalid_request: 'Use a supported integration action and its required fields. Execution identity is supplied by Canvas.',
  invalid_cursor: 'This catalogue page is no longer current. Start the search again.',
  provider_unavailable: 'The selected integration is unavailable. Check its connection before continuing.',
  provider_denied: 'This integration is not available to the current user, workspace or agent.',
  tool_not_found: 'Choose a tool from the current integration catalogue.',
  tool_denied: 'This integration action is not enabled for the current agent.',
  binding_changed: 'The selected account or connection changed. Load the tool schema again.',
  schema_changed: 'The tool schema or permissions changed. Load the current schema before execution.',
  invalid_arguments: 'The arguments do not match the current tool schema. Inspect the schema and correct the input.',
  schema_unsupported: 'This tool schema cannot be safely executed by the current runtime.',
  outcome_unknown: 'Execution may have completed. Check the selected provider before repeating. Do not retry or switch providers automatically.',
};

/** A non-serializable marker preserves known internal errors across Next and custom-server module copies. */
export function readIntegrationContractErrorCode(error: unknown): IntegrationErrorCode | undefined {
  if (!error || typeof error !== 'object'
    || (error as Record<symbol, unknown>)[Symbol.for('canvas.integration.contract-error.v1')] !== true
    || !('code' in error) || typeof error.code !== 'string'
    || !Object.hasOwn(INTEGRATION_GATEWAY_ERROR_MESSAGES, error.code)) return undefined;
  return error.code as IntegrationErrorCode;
}

export function readIntegrationGatewayErrorCode(toolName: string, details: unknown): IntegrationErrorCode | undefined {
  if (toolName !== 'integrations' || !details || typeof details !== 'object' || !('integrationError' in details)) return undefined;
  const error = details.integrationError as IntegrationErrorResult | undefined;
  if (!error || typeof error !== 'object') return undefined;
  if (error.version !== 1 || !error.error || !Object.hasOwn(INTEGRATION_GATEWAY_ERROR_MESSAGES, error.error.code)
    || error.error.message !== INTEGRATION_GATEWAY_ERROR_MESSAGES[error.error.code]) return undefined;
  return error.error.code;
}

/** No runtime or provider imports: automation and worker hooks use the same safe error marker. */
export function getIntegrationGatewayErrorOverride(context: AfterToolCallContext): AfterToolCallResult | undefined {
  const code = readIntegrationGatewayErrorCode(context.toolCall.name, context.result.details);
  if (!code) return undefined;
  return { isError: true, ...(code === 'outcome_unknown' ? { terminate: true } : {}) };
}
