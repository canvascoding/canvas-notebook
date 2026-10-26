import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { withDocumentOperationMetricObserver, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';

const selected = process.env.CANVAS_DOCUMENT_BASELINE_CASE;
assert(selected === 'editor-save' || selected === 'mcp-read' || selected === 'mcp-create');
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
assert(output && path.isAbsolute(output));
const measurements: DocumentOperationMeasurement[] = [];
// The real owned fixtures retain their native SQL, authentication, transport,
// content and cleanup assertions. No invocation or authority is synthesized.
await withDocumentOperationMetricObserver(value => measurements.push(value), async () => {
  if (selected === 'editor-save') await import('./native-document-search-room-postgres-test');
  else if (selected === 'mcp-read') await import('./document-read-tool-dispatch-postgres-test');
  else await import('./direct-mcp-native-markdown-create-postgres-test');
});
process.once('beforeExit', () => {
  // The existing Create fixture starts its own bounded child workers from
  // this same bundle. Their original completion/closure guards own their exit.
  if (process.env.CANVAS_NATIVE_MCP_CREATE_CHILD) return;
  if (process.exitCode) return;
  const expectedOperation = selected === 'editor-save' ? 'save' : selected === 'mcp-read' ? 'read' : 'create';
  const expectedActor = selected === 'editor-save' ? 'request' : 'mcp';
  assert(measurements.some(value => value.operation === expectedOperation && value.actor === expectedActor && value.outcome === 'succeeded'));
  assert(measurements.every(value => value.unsupportedQueryForms === 0 && value.openQueriesAtCompletion === 0));
  writeFileSync(output!, JSON.stringify({ version: 1, fixture: selected, measurements }, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ documentDispatchBaseline: true, fixture: selected, operations: measurements.length }));
});
