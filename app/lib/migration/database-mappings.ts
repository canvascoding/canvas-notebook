import type { MigrationImportUserMapping, MigrationImportWorkspaceMapping, CanvasMigrationManifest, MigrationWorkspaceDescriptor } from './types';
import { mapMigrationWorkspaces } from './mappings';

/** Database snapshots preserve identity-bearing namespaces; file imports support explicit reassignment. */
export function mapDatabaseUsers(source: Array<{ id: string; email: string | null }>, targets: Array<{ id: string; email: string | null }>): MigrationImportUserMapping[] {
  const ids = new Set<string>(); const emails = new Set<string>(); const selected = new Set<string>();
  return source.map(user => {
    const email = user.email?.trim().toLowerCase();
    if (!email || !user.id || ids.has(user.id) || emails.has(email)) throw new Error('Database snapshot contains duplicate or invalid user identities.');
    ids.add(user.id); emails.add(email);
    const matching = targets.filter(target => target.email?.trim().toLowerCase() === email);
    if (matching.length > 1) throw new Error('Target email identity is ambiguous.');
    const target = matching[0];
    if (target && target.id !== user.id) throw new Error('Database migration requires matching IDs for existing email identities. Use the file migration mapping for different accounts.');
    const collision = targets.find(candidate => candidate.id === user.id && candidate.email?.trim().toLowerCase() !== email);
    if (!target && collision) throw new Error('A source user ID belongs to a different target account.');
    const id = target?.id ?? user.id;
    if (selected.has(id)) throw new Error('Database user mappings conflict.'); selected.add(id);
    return { sourceUserId: user.id, sourceEmail: user.email, targetUserId: id, targetEmail: target?.email ?? user.email,
      status: 'mapped', required: true, reason: target ? 'Existing target account ID and email match; identity-bearing namespaces are preserved.' : 'Source account is created with the database snapshot.' };
  });
}

export function databaseMappedRoot(workspace: MigrationWorkspaceDescriptor, users: MigrationImportUserMapping[]): string {
  if (workspace.type !== 'personal') return workspace.rootRelativePath;
  const owner = users.find(user => user.sourceUserId === workspace.ownerUserId)?.targetUserId;
  const prefix = 'workspaces/personal/' + workspace.ownerUserId;
  if (!owner || !workspace.rootRelativePath.startsWith(prefix + '/')) throw new Error('Database personal workspace ownership is invalid.');
  return 'workspaces/personal/' + owner + workspace.rootRelativePath.slice(prefix.length);
}

export function mapDatabaseWorkspaces(manifest: CanvasMigrationManifest, archivePaths: string[], users: MigrationImportUserMapping[]): MigrationImportWorkspaceMapping[] {
  const workspaces = manifest.workspaces ?? [];
  const targets = workspaces.map(workspace => ({ ...workspace, rootRelativePath: databaseMappedRoot(workspace, users),
    ownerUserId: workspace.type === 'personal' ? users.find(user => user.sourceUserId === workspace.ownerUserId)?.targetUserId ?? null : workspace.ownerUserId }));
  const mapped = mapMigrationWorkspaces({ manifest, archivePaths, users, targets, choices: {
    users: {}, workspaces: Object.fromEntries(workspaces.map(workspace => ['data/' + workspace.rootRelativePath, workspace.id])),
  } });
  return mapped.map(mapping => mapping.kind === 'legacy' ? mapping : { ...mapping, reason: 'Workspace identity and mapped ownership are restored with the database snapshot.' });
}
