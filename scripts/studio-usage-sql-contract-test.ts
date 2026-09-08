import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function main() {
  const source = await readFile(new URL('../app/lib/integrations/studio-usage-reporting.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /to_timestamp\(\$\{studioGenerationOutputs\.createdAt\} \/ 1000\.0\)/,
    'Studio usage day grouping must convert epoch milliseconds to PostgreSQL seconds',
  );

  const epochMilliseconds = Date.parse('2026-03-16T12:00:00.000Z');
  assert.equal(new Date(epochMilliseconds).toISOString().slice(0, 10), '2026-03-16');

  console.log('[Studio Usage SQL Contract Test] Passed.');
}

void main();
