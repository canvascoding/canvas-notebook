import path from 'path';

import type { MigrationComponentKey, MigrationComponents } from '@/app/lib/migration/types';

export interface MigrationComponentPathMapping {
  component: MigrationComponentKey;
  dataPath: string[];
  archiveRoot: string;
}

const COMPONENT_PATH_MAPPINGS: MigrationComponentPathMapping[] = [
  { component: 'workspace', dataPath: ['workspace'], archiveRoot: 'data/workspace' },
  { component: 'studioAssets', dataPath: ['studio', 'assets'], archiveRoot: 'data/studio/assets' },
  { component: 'studioOutputs', dataPath: ['studio', 'outputs'], archiveRoot: 'data/studio/outputs' },
  { component: 'studioOutputs', dataPath: ['studio', 'edits'], archiveRoot: 'data/studio/edits' },
  { component: 'userUploads', dataPath: ['user-uploads'], archiveRoot: 'data/user-uploads' },
  { component: 'agents', dataPath: ['agents'], archiveRoot: 'data/agents' },
  { component: 'agents', dataPath: ['settings'], archiveRoot: 'data/settings' },
  { component: 'agents', dataPath: ['canvas-agent'], archiveRoot: 'data/canvas-agent' },
  { component: 'skills', dataPath: ['skills'], archiveRoot: 'data/skills' },
  { component: 'secrets', dataPath: ['secrets'], archiveRoot: 'data/secrets' },
];

export function getSelectedMigrationComponentPaths(components: MigrationComponents): MigrationComponentPathMapping[] {
  return COMPONENT_PATH_MAPPINGS.filter((mapping) => components[mapping.component]);
}

export function resolveMigrationDataPath(dataRoot: string, mapping: MigrationComponentPathMapping): string {
  return path.join(dataRoot, ...mapping.dataPath);
}
