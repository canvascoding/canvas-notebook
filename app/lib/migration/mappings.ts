import type { CanvasMigrationManifest, MigrationImportUserMapping, MigrationImportWorkspaceMapping,
  MigrationMappingChoices, MigrationWorkspaceDescriptor } from './types';

export function parseMigrationMappingChoices(input: unknown): MigrationMappingChoices {
  const result: MigrationMappingChoices = { users: {}, workspaces: {} };
  if (input === undefined) return result;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid migration mappings.');
  for (const kind of ['users', 'workspaces'] as const) {
    const value = (input as Record<string, unknown>)[kind];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2_000) throw new Error('Invalid migration mappings.');
    result[kind] = Object.fromEntries(Object.entries(value).map(([key, target]) => {
      if (!key || key.length > 2_048 || typeof target !== 'string' || !target || target.length > 256) throw new Error('Invalid migration mapping target.');
      return [key, target];
    }));
  }
  return result;
}

function safeRoot(value: string): boolean {
  return !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function parseMigrationWorkspaces(input: unknown): MigrationWorkspaceDescriptor[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 10_000) throw new Error('Invalid workspace inventory.');
  return input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace inventory.');
    const w = value as Record<string, unknown>;
    if (typeof w.id !== 'string' || !w.id || typeof w.rootRelativePath !== 'string' || !safeRoot(w.rootRelativePath)
      || !['personal', 'organization', 'team', 'project'].includes(String(w.type))) throw new Error('Invalid workspace inventory.');
    return { id: w.id, type: w.type as MigrationWorkspaceDescriptor['type'], rootRelativePath: w.rootRelativePath,
      displayName: typeof w.displayName === 'string' ? w.displayName : w.id,
      organizationId: typeof w.organizationId === 'string' ? w.organizationId : null,
      ownerUserId: typeof w.ownerUserId === 'string' ? w.ownerUserId : null };
  });
}

function compatible(source: string, target: string): boolean {
  if (source === 'organization' || source === 'team') return target === 'organization' || target === 'team';
  return source === target;
}

/** Map registered workspace roots, never infer a modern root from one path segment. */
export function mapMigrationWorkspaces(input: {
  manifest: CanvasMigrationManifest;
  archivePaths: string[];
  targets: MigrationWorkspaceDescriptor[];
  users: MigrationImportUserMapping[];
  choices?: MigrationMappingChoices;
}): MigrationImportWorkspaceMapping[] {
  const roots = new Map<string, Partial<Omit<MigrationWorkspaceDescriptor, 'type'>> & { type: MigrationImportWorkspaceMapping['kind']; rootRelativePath: string }>();
  for (const workspace of input.manifest.workspaces ?? []) {
    if (!safeRoot(workspace.rootRelativePath) || !workspace.rootRelativePath.startsWith(`workspaces/${workspace.type}/`)) throw new Error('Invalid source workspace root.');
    const prefix = 'data/' + workspace.rootRelativePath;
    if (input.archivePaths.some(p => p === prefix || p.startsWith(prefix + '/'))) {
      if (roots.has(prefix)) throw new Error('Duplicate source workspace root.');
      roots.set(prefix, workspace);
    }
  }
  for (const entry of input.archivePaths) {
    if (entry.startsWith('data/workspace/')) roots.set('data/workspace', { type: 'legacy', rootRelativePath: 'workspace' });
    if (!entry.startsWith('data/workspaces/')) continue;
    if ([...roots.keys()].some(root => entry === root || entry.startsWith(root + '/') || root.startsWith(entry.replace(/\/$/u, '') + '/'))) continue;
    const match = /^data\/(workspaces\/(organization|team|personal|project)\/[^/]+(?:\/[^/]+)*?\/files)(?:\/|$)/u.exec(entry);
    if (match) {
      const type = match[2] as MigrationWorkspaceDescriptor['type'];
      roots.set('data/' + match[1], { type, rootRelativePath: match[1],
        ownerUserId: type === 'personal' ? match[1].split('/')[2] : null });
    } else if (!entry.endsWith('/')) {
      roots.set(entry, { type: 'unknown', rootRelativePath: entry.slice(5) });
    }
  }
  return [...roots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sourcePath, source]) => {
    if (source.type === 'legacy') return { kind: 'legacy', sourcePath, sourceWorkspaceId: null,
      sourceOrganizationId: null, sourceOwnerUserId: null, targetWorkspaceId: null, targetPath: sourcePath,
      status: 'mapped', required: false, reason: 'Legacy workspace files retain their explicit legacy root.' };
    const owner = source.ownerUserId ? input.users.find(user => user.sourceUserId === source.ownerUserId && user.status === 'mapped')?.targetUserId : null;
    const eligible = input.targets.filter(target => safeRoot(target.rootRelativePath) && compatible(source.type, target.type)
      && (source.type !== 'personal' || Boolean(owner && target.ownerUserId === owner)));
    const chosenId = input.choices?.workspaces[sourcePath];
    const chosen = chosenId ? eligible.find(target => target.id === chosenId) : undefined;
    if (chosenId && !chosen) throw new Error('The selected target workspace is unavailable or does not match its mapped owner/type.');
    const exact = eligible.find(target => target.rootRelativePath === source.rootRelativePath
      && (!source.id || target.id === source.id)
      && (!source.organizationId || target.organizationId === source.organizationId));
    const proposal = eligible.find(target => source.displayName && target.displayName === source.displayName);
    const target = chosen ?? exact ?? proposal;
    return { kind: source.type, sourcePath, sourceWorkspaceId: source.id ?? null,
      sourceOrganizationId: source.organizationId ?? null, sourceOwnerUserId: source.ownerUserId ?? null,
      targetWorkspaceId: target?.id ?? null, targetPath: target ? 'data/' + target.rootRelativePath : null,
      status: chosen || exact ? 'mapped' : proposal ? 'proposed' : 'unresolved', required: true,
      reason: chosen ? 'Target workspace explicitly selected by the administrator.' : exact
        ? 'Existing workspace identity, owner and registered root match.'
        : 'Select a target workspace explicitly before applying these files.' };
  });
}
