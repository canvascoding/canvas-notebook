import 'server-only';

import { serializeWorkspaceOperationRequest, type WorkspaceOperationRequest } from './workspace-operation-journal';

const MAX_REQUEST_BYTES = 65536;

export class NativeCopyRequestTooLargeError extends Error {
  readonly code = 'NATIVE_COPY_REQUEST_TOO_LARGE';
  readonly status = 413;

  constructor() {
    super('NATIVE_COPY_REQUEST_TOO_LARGE');
    this.name = 'NativeCopyRequestTooLargeError';
  }
}

/** A new resolved Owner request only: captured Origin and final plan selections.
 * Object-key ordering does not change JSON's UTF-8 cost. Check that cost first
 * so ASCII overflow does not escape as the journal's generic character error;
 * then validate and check the actual canonical journal serialization as well.
 * Existing original requests are validated by their unchanged recovery path. */
export function assertNativeCopyRequestBudget(request: WorkspaceOperationRequest): void {
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES) {
    throw new NativeCopyRequestTooLargeError();
  }
  const { requestJson } = serializeWorkspaceOperationRequest(request);
  if (Buffer.byteLength(requestJson, 'utf8') > MAX_REQUEST_BYTES) {
    throw new NativeCopyRequestTooLargeError();
  }
}
