import 'server-only';
import { types } from 'node:util';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { directMcpCorrelationId } from './diagnostics';

const phases = new Set(['dispatch', 'create', 'status', 'admission', 'snapshot_validate', 'receipt_begin',
  'file_write', 'checkpoint_confirm', 'projection_finalize', 'receipt_finalize', 'birth_open', 'birth_verify',
  'birth_prepare', 'birth_publish', 'birth_observe', 'birth_complete', 'birth_finalize', 'publication_authority']);

/** Follow only bounded primary causes, without invoking getters or returning
 * exception messages, SQL, paths or credentials. */
export function directMcpFailurePhase(error: unknown, fallback: string): string {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !types.isProxy(current); depth++) {
    const fields = Object.getOwnPropertyDescriptors(current);
    const phase = fields.collaborationPhase?.value;
    if (typeof phase === 'string' && phases.has(phase)) return phase;
    current = fields.cause?.value ?? (current instanceof AggregateError && Array.isArray(fields.errors?.value)
      ? fields.errors.value[0] : undefined);
  }
  return phases.has(fallback) ? fallback : 'dispatch';
}

export type DirectMcpFailureDiagnostic = {
  code: string; correlation_id: string; phase: string;
  storage_status: string; retryable: boolean; operation_id?: string;
};

/** Only explicitly selected bounded operational facts enter the log. */
export function logDirectMcpToolFailure(value: DirectMcpFailureDiagnostic): void {
  console.warn('[direct-mcp]', JSON.stringify({ event: 'tool_failure',
    correlation_id: value.correlation_id,
    code: /^[A-Z0-9_]{1,120}$/u.test(value.code) ? value.code : 'MCP_TOOL_FAILED',
    phase: phases.has(value.phase) ? value.phase : 'dispatch',
    storage_status: ['confirmed', 'unknown', 'not_applicable'].includes(value.storage_status) ? value.storage_status : 'unknown',
    retryable: value.retryable === true,
    ...(value.operation_id && /^[a-zA-Z0-9._:-]{1,256}$/u.test(value.operation_id) ? { operation_id: value.operation_id } : {}),
  }));
}

export function unexpectedDirectMcpToolFailure(error: unknown): CallToolResult {
  const body = { success: false, code: 'MCP_TOOL_FAILED', correlation_id: directMcpCorrelationId(),
    phase: directMcpFailurePhase(error, 'dispatch'), storage_status: 'unknown', retryable: false,
    message: 'The outcome could not be confirmed. Inspect operation status before retrying a write.' };
  logDirectMcpToolFailure(body);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}
