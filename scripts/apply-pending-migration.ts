import { applyPendingMigrationRestore } from '../app/lib/migration/restore-executor';
import { closeDatabaseConnections } from '../app/lib/db';

applyPendingMigrationRestore().then(result => {
  if (result) console.log(`[Migration Restore] ${result.status}: ${result.id}; files=${result.filesApplied}; rollback=${result.rollbackComplete}`);
  return closeDatabaseConnections();
}).then(() => process.exit(0), () => {
  console.error('[Migration Restore] Recovery could not finish safely. Application startup is stopped; inspect private migration state.');
  process.exit(1);
});
