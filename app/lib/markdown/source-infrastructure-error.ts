import { types } from 'node:util';

/** An interrupted database/principal is not a document parsing gap. Preserve
 * the original object for the owning transaction's rollback and error mapping. */
export function rethrowSourceInfrastructureError(error: unknown): void {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return;
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  if (typeof code === 'string' && (/^08[A-Z0-9]{3}$/u.test(code)
    || ['57014', '25P04', '25P02', '55P03', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(code)
    || code.startsWith('MCP_READ_PRINCIPAL_') || code === 'MCP_READ_PHASE_TIMEOUT')) throw error;
}
