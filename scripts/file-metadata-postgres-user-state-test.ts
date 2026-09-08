import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await postgres.exec(`
      CREATE TABLE workspace_file_metadata (workspace_id text, path text, title text);
      CREATE TABLE workspace_file_user_states (workspace_id text, user_id text, path text, is_favorite boolean, pinned_at bigint);
      INSERT INTO workspace_file_metadata VALUES ('workspace-1', 'docs/readme.md', 'Readme');
      INSERT INTO workspace_file_user_states VALUES ('workspace-1', 'user-1', 'docs/readme.md', true, 123);
    `);

    const paths = ['docs/readme.md'];
    const metadataPlaceholders = paths.map((_, index) => `$${index + 2}`).join(', ');
    const metadata = await postgres.query(
      `SELECT path, title FROM workspace_file_metadata WHERE workspace_id = $1 AND path IN (${metadataPlaceholders})`,
      ['workspace-1', ...paths],
    );
    assert.deepEqual(metadata.rows, [{ path: 'docs/readme.md', title: 'Readme' }]);

    const statePlaceholders = paths.map((_, index) => `$${index + 3}`).join(', ');
    const states = await postgres.query(
      `SELECT path, is_favorite, pinned_at FROM workspace_file_user_states WHERE workspace_id = $1 AND user_id = $2 AND path IN (${statePlaceholders})`,
      ['workspace-1', 'user-1', ...paths],
    );
    assert.deepEqual(states.rows, [{ path: 'docs/readme.md', is_favorite: true, pinned_at: 123 }]);
  } finally {
    await postgres.close();
  }
}

main().then(() => {
  console.log('file metadata PostgreSQL user-state placeholder test passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
