import { createRequire } from 'node:module';

import { runStartupDatabaseMigrations } from '../app/lib/db/startup-migrations';

const require = createRequire(import.meta.url);
const { loadAppEnv } = require('../server/load-app-env.js') as {
  loadAppEnv: (cwd?: string) => string | null;
};

async function main() {
  loadAppEnv(process.cwd());
  await runStartupDatabaseMigrations();
}

void main().catch((error) => {
  console.error('[database-migrations] Failed:', error);
  process.exitCode = 1;
});
