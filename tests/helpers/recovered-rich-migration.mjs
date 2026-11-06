import { roomReadConsoleMessage } from './recovered-room-read.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const proof = /^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u;
const requestKeys = ['documentSequence', 'expectedDocumentId', 'expectedLifecycleGeneration', 'requestId', 'stateProof'];

function validRequest(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === requestKeys.join(',')
    && uuid.test(value.requestId) && typeof value.expectedDocumentId === 'string' && value.expectedDocumentId.length > 0
    && Number.isSafeInteger(value.expectedLifecycleGeneration) && value.expectedLifecycleGeneration > 0
    && Number.isSafeInteger(value.documentSequence) && value.documentSequence >= 0 && proof.test(value.stateProof);
}

function sameRequest(left, right) {
  return validRequest(left) && validRequest(right) && requestKeys.every(key => left[key] === right[key]);
}

/** A browser's automatic 503 console message is expected only when that same
 * client completes the exact pending migration promptly, without an early ticket.
 * Unknown failures, other clients, changed identity and earlier successes remain errors.
 */
export function recoveredRichMigrationErrors(responses, consoleErrors) {
  const recovered = new Set();
  for (const { client, url } of consoleErrors) {
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (typeof client !== 'string' || !client || !['http:', 'https:'].includes(parsed.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password
      || parsed.pathname !== '/api/files/collaboration/session' || parsed.search || parsed.hash) continue;
    const reads = responses.filter(row => row.client === client && row.url === url);
    const failures = reads.filter(row => row.status >= 400);
    const messages = consoleErrors.filter(row => row.client === client && row.url === url);
    if (!failures.length || failures.length > 2 || failures.length !== messages.length
      || messages.some(row => row.message !== roomReadConsoleMessage)) continue;
    if (!failures.every(failure => {
      const request = failure.requestMigration, pending = failure.migration;
      if (failure.method !== 'POST' || failure.status !== 503 || failure.success !== false
        || failure.credentialFieldsPresent !== false || failure.ticketIssued !== false || failure.code != null
        || !['auto', 'tiptap_blocks'].includes(failure.requestRepresentation)
        || typeof failure.path !== 'string' || !failure.path || !validRequest(request)
        || pending?.status !== 'pending' || pending.requestId !== request.requestId
        || pending.documentId !== request.expectedDocumentId
        || !['quiescence', 'handoff', 'projection'].includes(pending.phase)
        || pending.reason != null && (pending.reason !== 'ADMISSION_SCOPE_CHANGED' || pending.phase !== 'handoff')
        || !Number.isSafeInteger(pending.lifecycleGeneration)
        || pending.lifecycleGeneration < request.expectedLifecycleGeneration
        || pending.lifecycleGeneration > request.expectedLifecycleGeneration + 1 || !Number.isFinite(failure.at)) return false;
      return reads.some((success, index) => index > reads.indexOf(failure)
        && success.method === 'POST' && success.status === 200 && success.success === true && success.ticketIssued === true
        && success.path === failure.path && success.requestRepresentation === failure.requestRepresentation
        && sameRequest(success.requestMigration, request) && success.documentId === request.expectedDocumentId
        && success.lifecycleGeneration === request.expectedLifecycleGeneration + 1 && success.representation === 'tiptap_blocks'
        && success.migration?.requestId === request.requestId && success.migration.documentId === request.expectedDocumentId
        && success.migration.lifecycleGeneration === success.lifecycleGeneration
        && ['migrated', 'already_rich'].includes(success.migration.status)
        && Number.isFinite(success.at) && success.at >= failure.at && success.at - failure.at <= 5_000);
    })) continue;
    for (const message of messages) recovered.add(message.value);
  }
  return recovered;
}
