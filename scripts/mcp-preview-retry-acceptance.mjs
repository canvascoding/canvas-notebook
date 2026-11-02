import assert from 'node:assert/strict';

/** Only read-only previews may be repeated here. Preserve every advertised
 * transient conflict in the evidence; never hide timeout/performance failures. */
export async function previewWithTransientRetries(call, request) {
  assert.equal(request.api_version, 1);
  assert.equal(request.action, 'preview');
  const retries = [];
  let response = await call('delete_knowledge_source', request);
  while (response.isError && response.structuredContent?.retryable === true
    && ['PATH_SOURCE_INCOMPLETE', 'PATH_BUSY', 'PATH_PLAN_CHANGED'].includes(response.structuredContent.code)
    && retries.length < 10) {
    const failure = response.structuredContent;
    assert(failure.correlation_id); assert.equal(failure.phase, 'preview');
    assert.equal(failure.storage_status, 'not_applicable');
    retries.push({ code: failure.code, correlationId: failure.correlation_id, issues: failure.issues });
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, failure.retry_after_ms || 250)));
    response = await call('delete_knowledge_source', request);
  }
  return { response, retries };
}
