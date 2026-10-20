import 'server-only';
import { assertMigrationArchivePath } from './archive';

export type DatabaseWorkspaceRoot = { id: string; type: string; rootRelativePath: string; ownerUserId: string | null; organizationId: string | null };
export function assertDatabaseWorkspaceRoot(workspace: DatabaseWorkspaceRoot): void {
  if (!['personal', 'organization', 'team', 'project'].includes(workspace.type)
    || typeof workspace.rootRelativePath !== 'string'
    || !workspace.rootRelativePath.startsWith('workspaces/' + workspace.type + '/')) throw new Error('Database snapshot contains an unsupported workspace root.');
  assertMigrationArchivePath('data/' + workspace.rootRelativePath);
  if (workspace.type === 'personal' && workspace.ownerUserId
    && !workspace.rootRelativePath.startsWith('workspaces/personal/' + workspace.ownerUserId + '/')) throw new Error('Database workspace root does not match its owner.');
}
