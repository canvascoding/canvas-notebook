import assert from 'node:assert/strict';
import { CollaborationDocumentLocationRequestError, createDocumentLocationRetryBudget,
  isRetryableDocumentLocationFailure, nextDocumentLocationRetryDelay } from '../app/lib/collaboration/document-location-retry';
import { requestCollaborationDocumentLocation } from '../app/lib/collaboration/document-location-request';
import { invalidateOpenedDocumentAuth, observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Pure policy and controlled HTTP adapters only. No fixture below proves SQL
 * rollback/close, transport disposal, or an actual session grant. */
async function main() {
  const originalFetch = globalThis.fetch;
  const location = { success: true, workspaceId: 'workspace', documentId: 'document', path: 'note.md',
    lifecycleGeneration: 1, representation: 'plain_text' };
  const marked = Object.assign(new Error('Clean read marker model'), { code: 'NATIVE_SESSION_BUSY', status: 409, retryable: true });
  assert.equal(isRetryableDocumentLocationFailure(marked), true);
  for (const failure of [new Error('unknown'), null, undefined,
    { code: 'NATIVE_SESSION_BUSY', status: 409 },
    { code: 'NATIVE_SESSION_BUSY', status: 409, retryable: 'true' },
    { code: 'NATIVE_SESSION_BUSY', status: 503, retryable: true },
    { code: 'PRINCIPAL_BUSY', status: 401, retryable: true },
    { code: 'NATIVE_SESSION_BUSY', status: 403, retryable: true },
    { code: 'OTHER_BUSY', status: 409, retryable: true },
    { code: 'FILE_MUTATION_LOCK_BUSY', status: 503, retryable: true },
    new CollaborationDocumentLocationRequestError('Unavailable', { code: 'FILE_MUTATION_LOCK_UNAVAILABLE', status: 503, retryable: true }),
  ]) assert.equal(isRetryableDocumentLocationFailure(failure), false);
  const budget = createDocumentLocationRetryBudget(1000);
  let clock = 1000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    budget.attempts = attempt;
    const delay = nextDocumentLocationRetryDelay(budget, marked, clock);
    if (attempt < 6) { assert.equal(delay, [1000, 1500, 2500, 4000, 6000][attempt - 1]); clock += delay!; }
    else assert.equal(delay, null, 'Six attempts exhaust one shared window.');
  }
  const deadline = createDocumentLocationRetryBudget(0); deadline.attempts = 1;
  assert.equal(nextDocumentLocationRetryDelay(deadline, marked, 19_500), null, 'Backoff cannot extend the deadline.');
  assert.equal(nextDocumentLocationRetryDelay(deadline, marked, 20_000), null);
  assert.equal(nextDocumentLocationRetryDelay(createDocumentLocationRetryBudget(0), new Error('terminal'), 0), null);

  observeOpenedDocumentAuth({ data: { user: { id: 'retry-user' }, session: { id: 'retry-session' } } });
  try {
    for (const code of ['FILE_MUTATION_LOCK_TIMEOUT', 'FILE_MUTATION_LOCK_BUSY']) {
      globalThis.fetch = async () => Response.json({ success: false, code, retryable: true }, { status: 503 });
      await assert.rejects(requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal),
        error => isRetryableDocumentLocationFailure(error));
    }
    for (const [status, payload] of [
      [503, { success: false, code: 'FILE_MUTATION_LOCK_BUSY' }],
      [503, { success: false, code: 'FILE_MUTATION_LOCK_UNAVAILABLE', retryable: true }],
      [503, { success: false, code: 'OTHER_BUSY', retryable: true }],
      [409, { success: false, code: 'NATIVE_SESSION_BUSY', retryable: true }],
      [401, { success: false, code: 'FILE_MUTATION_LOCK_BUSY', retryable: true }],
      [403, { success: false, code: 'FILE_MUTATION_LOCK_BUSY', retryable: true }],
    ] as const) {
      globalThis.fetch = async () => Response.json(payload, { status });
      await assert.rejects(requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal),
        error => !isRetryableDocumentLocationFailure(error));
    }
    globalThis.fetch = async () => new Response('{', { status: 503 });
    await assert.rejects(requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal),
      error => !isRetryableDocumentLocationFailure(error));
    globalThis.fetch = async () => Response.json({ ...location, documentId: 'reused-document' });
    await assert.rejects(requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal),
      error => !isRetryableDocumentLocationFailure(error));
    globalThis.fetch = async () => Response.json({ success: false }, { status: 404 });
    assert.equal(await requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal), null);
    globalThis.fetch = async () => { throw new TypeError('Controlled read network failure'); };
    await assert.rejects(requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal),
      error => isRetryableDocumentLocationFailure(error));

    // A fetch adapter that ignores abort must not retain a logical request slot.
    const retainedFetch = deferred<Response>(), fetchController = new AbortController();
    globalThis.fetch = async () => retainedFetch.promise;
    const fetchAttempt = requestCollaborationDocumentLocation('workspace', 'document', fetchController.signal);
    let fetchSettled = false;
    const fetchResult = assert.rejects(fetchAttempt, error => error === fetchController.signal.reason).then(() => { fetchSettled = true; });
    fetchController.abort(new CollaborationDocumentLocationRequestError('Owned read timeout', { code: 'LOCATION_TIMEOUT', retryable: true }));
    await flush(); assert.equal(fetchSettled, true, 'Cancellation settles before the ignored fetch response.');
    await fetchResult;
    retainedFetch.resolve(Response.json(location)); await flush();

    // Body parsing has an independent cancellation race too. This is an
    // explicitly controlled body adapter on a real Response, not a server proof.
    const retainedBody = deferred<unknown>(), bodyController = new AbortController();
    globalThis.fetch = async () => Object.assign(Response.json(location), { json: () => retainedBody.promise });
    const bodyAttempt = requestCollaborationDocumentLocation('workspace', 'document', bodyController.signal);
    let bodySettled = false;
    const bodyResult = assert.rejects(bodyAttempt, error => error === bodyController.signal.reason).then(() => { bodySettled = true; });
    await flush(); bodyController.abort(new Error('Disposed tab'));
    await flush(); assert.equal(bodySettled, true, 'Cancellation settles before the ignored JSON body.');
    await bodyResult; retainedBody.resolve(location); await flush();

    const authGate = deferred<Response>();
    globalThis.fetch = async () => authGate.promise;
    const oldAuthAttempt = requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal);
    const oldAuthResult = assert.rejects(oldAuthAttempt, error => !isRetryableDocumentLocationFailure(error));
    invalidateOpenedDocumentAuth(); authGate.resolve(Response.json(location)); await oldAuthResult;
    const bodyAuth = deferred<unknown>();
    globalThis.fetch = async () => Object.assign(Response.json(location), { json: () => bodyAuth.promise });
    const oldBodyAttempt = requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal);
    const oldBodyResult = assert.rejects(oldBodyAttempt, error => !isRetryableDocumentLocationFailure(error));
    await flush(); invalidateOpenedDocumentAuth(); bodyAuth.resolve(location); await oldBodyResult;
    globalThis.fetch = async () => Response.json(location);
    assert.deepEqual(await requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal), {
      workspaceId: 'workspace', documentId: 'document', path: 'note.md', lifecycleGeneration: 1, representation: 'plain_text',
    });
    console.log('Location retry policy, strict HTTP classification, ignored fetch/body cancellation and fresh auth scope checks passed (controlled adapters only).');
  } finally { globalThis.fetch = originalFetch; observeOpenedDocumentAuth(null); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
