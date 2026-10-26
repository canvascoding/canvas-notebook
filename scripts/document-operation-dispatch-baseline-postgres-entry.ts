import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { measureDocumentDatabaseActivity, withDocumentOperationMetricObserver,
  type DocumentDatabaseActivityMeasurement, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';

const selected = process.env.CANVAS_DOCUMENT_BASELINE_CASE;
assert(selected === 'editor-save' || selected === 'mcp-read' || selected === 'mcp-create');
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
assert(output && path.isAbsolute(output));
const measurements: DocumentOperationMeasurement[] = [];
const databaseActivities: DocumentDatabaseActivityMeasurement[] = [];
// The real owned fixtures retain their native SQL, authentication, transport,
// content and cleanup assertions. No invocation or authority is synthesized.
await withDocumentOperationMetricObserver(value => measurements.push(value), async () => {
  if (selected === 'editor-save') await measureDocumentDatabaseActivity('save', 'request', async () => {
    const fixture = await import('./native-document-search-room-postgres-test');
    await fixture.nativeDocumentSearchRoomPostgresCompletion;
  }, value => databaseActivities.push(value));
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
  if (selected === 'editor-save') {
    assert.equal(databaseActivities.length, 1);
    const total = databaseActivities[0];
    assert.equal(total.scopedStatements, measurements.reduce((sum, value) => sum + value.statements, 0));
    assert(total.unscopedStatements > 0, 'The complete fixture includes actual runtime SQL outside per-operation contexts.');
    assert.equal(total.statements, total.scopedStatements + total.unscopedStatements);
    assert.equal(total.openQueriesAtCompletion, 0); assert.equal(total.openConnectionsAtCompletion, 0);
    assert.equal(total.unsupportedQueryForms, 0);
  }
  writeFileSync(output!, JSON.stringify({ version: 2, fixture: selected, measurements,
    activityScope: selected === 'editor-save' ? 'whole-existing-fixture-including-preparation-and-cleanup' : null,
    databaseActivities }, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ documentDispatchBaseline: true, fixture: selected, operations: measurements.length,
    activityStatements: databaseActivities[0]?.statements }));
});
