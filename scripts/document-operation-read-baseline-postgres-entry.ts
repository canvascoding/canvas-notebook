import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { withDocumentOperationMetricObserver, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';

const measurements: DocumentOperationMeasurement[] = [];
// The existing owned fixture retains all genuine service/fault assertions.
// Its beforeExit guard rejects unfinished asynchronous work.
await withDocumentOperationMetricObserver(value => measurements.push(value), () => import('./document-read-service-postgres-test'));
process.once('beforeExit', () => {
  const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
  if (!output || !path.isAbsolute(output)) { process.exitCode = 1; return; }
  if (!measurements.some(value => value.operation === 'read' && value.actor === 'request' && value.outcome === 'succeeded')
    || !measurements.some(value => value.actor === 'agent') || measurements.some(value => value.unsupportedQueryForms)) {
    process.exitCode = 1; return;
  }
  writeFileSync(output, JSON.stringify({ version: 1, fixture: 'owned-document-public-read-service', measurements }, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ documentReadBaseline: true, operations: measurements.length }));
});
