/** Shared acceptance through actual HTTP or installed Codex MCP transport.
 * Synthetic documents only. Fault injection belongs in the isolated PG suites. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function verifyOperationReliabilityAcceptance(call, key) {
  const checks = [];
  const success = result => {
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert(result.structuredContent); return result.structuredContent;
  };
  const content = '# Reliability BEFORE\n\n' + Array.from({ length: 200 }, (_, i) =>
    `Section ${i}: ${'Bounded native target inspection. '.repeat(20).trimEnd()}`).join('\n\n') + '\n';
  const request = { api_version: 1, path: `reliability-${key}.md`, content, idempotency_key: `${key}-create` };
  const created = success(await call('create_knowledge_source', request));
  assert.equal(created.apiVersion, 1); assert.equal(created.outcome, 'created');
  const identity = created.document;
  assert.equal(identity.representation, 'tiptap_blocks', 'Use canonical rich Markdown for the block-edit fixture.');
  const createUrl = new URL(created.document_url);
  assert.equal(createUrl.searchParams.get('documentId'), identity.documentId);
  assert.equal(createUrl.searchParams.get('path'), request.path);
  const status = success(await call('create_knowledge_source', {
    action: 'status', path: request.path, idempotency_key: request.idempotency_key,
  }));
  assert.equal(status.storage_status, 'confirmed'); assert.equal(status.document_id, identity.documentId);
  assert.equal(status.source_sha256, createHash('sha256').update(content).digest('hex'));
  const repeated = success(await call('create_knowledge_source', request));
  assert.equal(repeated.document.documentId, identity.documentId); assert.equal(repeated.outcome, 'already_created');
  checks.push('native Create URL, original hash/status and same-key retry');
  const read = args => call('read_knowledge_source', { document_id: identity.documentId, ...args });
  const text = success(await read({ format: 'text', max_bytes: 4096 }));
  assert.equal(text.format, 'text'); assert.equal(text.byteLength, 4096); assert(text.nextCursor);
  const native = success(await read({ format: 'native', max_bytes: 262144 })); assert(native.complete);
  const nativeBody = JSON.parse(native.fragment);
  const heading = nativeBody.content.document.content.find(node => node.type === 'heading'); assert(heading?.attrs.id);
  const tooLarge = await read({ include_edit_targets: true, max_bytes: 4 });
  assert.equal(tooLarge.isError, true); assert.equal(tooLarge.structuredContent.code, 'DOCUMENT_TOO_LARGE');
  assert.match(tooLarge.structuredContent.hint, /edit_target_block_id/);
  assert.equal(tooLarge.structuredContent.error_code, 'DOCUMENT_TOO_LARGE');
  const selection = { include_edit_targets: true, edit_target_block_id: heading.attrs.id, expected_version: native.document.version };
  const first = success(await read({ ...selection, max_bytes: 64 })); assert(first.nextCursor);
  let fragments = first.fragment, cursor = first.nextCursor;
  while (cursor) { const page = success(await read({ ...selection, max_bytes: 64, cursor })); fragments += page.fragment; cursor = page.nextCursor; }
  const targetBody = JSON.parse(fragments); assert.equal(targetBody.content, undefined);
  assert.equal(targetBody.editTargets.length, 1); assert.equal(targetBody.editTargets[0].id, heading.attrs.id);
  checks.push('text/4096 transport and bounded selected-target continuation beyond full-list limit');
  const patch = { api_version: 1, action: 'edit', document_id: identity.documentId,
    expected_version: native.document.version, idempotency_key: `${key}-edit`,
    patch: { kind: 'native_text_replace', blockId: heading.attrs.id,
      edits: [{ oldText: 'Reliability BEFORE', newText: 'Reliability AFTER', expectedOccurrences: 1 }] } };
  let edited = success(await call('edit_knowledge_source', patch));
  for (let attempt = 0; edited.state === 'pending' && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    edited = success(await call('edit_knowledge_source', { api_version: 1, action: 'status', operation_id: edited.operationId }));
  }
  assert.equal(edited.state, 'confirmed'); assert.equal(edited.persistence.status, 'confirmed');
  const editUrl = new URL(edited.document_url); assert.equal(editUrl.searchParams.get('documentId'), identity.documentId);
  assert.equal(editUrl.searchParams.get('lineageId'), identity.lineageId);
  const editStatus = success(await call('edit_knowledge_source', { api_version: 1, action: 'status', operation_id: edited.operationId }));
  assert.equal(editStatus.state, 'confirmed'); assert.equal(editStatus.document_url, edited.document_url);
  const oldCursor = await read({ ...selection, cursor: first.nextCursor, max_bytes: 64 });
  assert.equal(oldCursor.isError, true); assert.equal(oldCursor.structuredContent.code, 'DOCUMENT_VERSION_CONFLICT');
  const mixed = await call('edit_knowledge_source', { ...patch, path: request.path });
  assert.equal(mixed.isError, true); assert.equal(mixed.structuredContent.code, 'INVALID_REQUEST');
  const after = success(await read({ format: 'text', max_bytes: 4096 })); assert(after.fragment.includes('Reliability AFTER'));
  let formatted = success(await call('edit_knowledge_source', { api_version: 1, action: 'edit',
    document_id: identity.documentId, expected_version: after.document.version, idempotency_key: `${key}-blocks`,
    patch: { kind: 'native_blocks', operations: [{ kind: 'format_block', blockId: heading.attrs.id,
      beforeAttrs: { level: heading.attrs.level }, afterAttrs: { level: 2 } }] } }));
  for (let attempt = 0; formatted.state === 'pending' && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    formatted = success(await call('edit_knowledge_source', { api_version: 1, action: 'status', operation_id: formatted.operationId }));
  }
  assert.equal(formatted.state, 'confirmed'); assert.equal(formatted.persistence.status, 'confirmed');
  assert.equal(formatted.document_url, edited.document_url);
  const finalBody = JSON.parse(success(await read({ format: 'native', max_bytes: 262144 })).fragment);
  assert.equal(finalBody.content.document.content.find(node => node.attrs?.id === heading.attrs.id).attrs.level, 2);
  checks.push('both typed patch variants, confirmed Edit/status URL, old-version rejection and mixed-shape rejection');
  const missing = await call('read_knowledge_source', { path: `missing-${key}.md` });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error_code, 'DOCUMENT_NOT_FOUND');
  const deletePreviews = [];
  for (let index = 0; index < 6; index++) {
    const path = `preview-${key}-${index}.md`;
    const content = `# Preview ${index}\n\nSynthetic local test.\n`;
    success(await call('create_knowledge_source', { api_version: 1, path,
      content, idempotency_key: `${key}-preview-${index}` }));
    const readBack = success(await call('read_knowledge_source', { path }));
    assert.equal(readBack.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(readBack.content, content);
    const preview = success(await call('delete_knowledge_source', { api_version: 1, action: 'preview', path }));
    assert.equal(preview.action, 'preview');
    assert.equal(preview.preview.kind, 'delete');
    assert.equal(preview.preview.readiness, 'ready');
    deletePreviews.push({ path, sha256: readBack.sha256, planId: preview.preview.planId, readiness: preview.preview.readiness });
  }
  checks.push('missing path domain error and six sequential native creates with delete previews');
  return { checks, deletePreviews, documentId: identity.documentId, createUrl: created.document_url, editUrl: edited.document_url, expectedText: 'Reliability AFTER' };
}


/** A separate workspace deliberately contains uninspectable frontmatter. */
export async function verifySourceCoverageAcceptance(call, key, seedInvalid) {
  const documents = [
    { path: `coverage-target-${key}.md`, content: '# Safe target\n' },
    { path: 'coverage-invalid-frontmatter.md', content: '---\nbroken: [\n---\n\n# Invalid metadata\n' },
  ];
  if (seedInvalid) await seedInvalid(documents[1]);
  const created = await call('create_knowledge_source', { api_version: 1, ...documents[0],
    idempotency_key: `${key}-${documents[0].path}` });
  assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
  const response = await call('delete_knowledge_source', {
    api_version: 1, action: 'preview', path: documents[0].path,
  });
  assert.equal(response.isError, true);
  const failure = response.structuredContent;
  assert.equal(failure.code, 'PATH_SOURCE_INCOMPLETE');
  assert.equal(failure.error_code, 'PATH_SOURCE_INCOMPLETE');
  assert.equal(failure.phase, 'preview');
  assert.equal(failure.retryable, false);
  assert(failure.correlation_id);
  assert(failure.issues.some(issue => issue.code === 'invalid-frontmatter' && issue.path === documents[1].path));
  assert.equal(failure.preview, undefined);
  for (const document of documents) {
    const read = await call('read_knowledge_source', { path: document.path });
    assert.notEqual(read.isError, true);
    assert.equal(read.structuredContent.content, document.content);
    assert.equal(read.structuredContent.sha256, createHash('sha256').update(document.content).digest('hex'));
  }
  return { code: failure.code, correlationId: failure.correlation_id, issues: failure.issues,
    preservedDocuments: documents.map(document => document.path) };
}
