import assert from 'node:assert/strict';
import { nativeCopyHistoricalReceiptPostgresTest } from './native-copy-historical-receipt-postgres-test';

assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
assert(process.env.DATABASE_URL, 'Managed PostgreSQL connection must be present.');
await nativeCopyHistoricalReceiptPostgresTest();
