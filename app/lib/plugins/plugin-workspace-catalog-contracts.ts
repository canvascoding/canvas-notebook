import type { CapabilityResourceAccess, CapabilityResourceDescriptor, CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';

export const PLUGIN_WORKSPACE_CATALOG_SCHEMA_VERSION = 1;
export const PLUGIN_WORKSPACE_CATALOG_DEFAULT_LIMIT = 20;
export const PLUGIN_WORKSPACE_CATALOG_MAX_LIMIT = 50;
export const PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES = 200;

export type PluginWorkspaceCatalogScope = 'all' | 'user' | 'team' | 'organization' | 'system';
export type PluginWorkspaceCatalogAudience = 'own' | 'shared';
export type PluginWorkspaceCatalogQuery = {
  kind: 'plugin' | 'skill' | null;
  scope: PluginWorkspaceCatalogScope;
  audience: PluginWorkspaceCatalogAudience | null;
  teamId: string | null;
  q: string;
  page: number;
  limit: number;
};

/** Installed management metadata. This item does not grant runtime activation or execution. */
export type PluginWorkspaceCatalogItem = {
  resourceRef: string;
  legacyResourceId: string;
  kind: 'plugin' | 'skill';
  name: string;
  displayName: string;
  description: string;
  version: string;
  revision: number;
  ownership: CapabilityResourceOwnerScope;
  ownershipLabel?: string;
  access: CapabilityResourceAccess;
  activation?: NonNullable<CapabilityResourceDescriptor['activation']>;
  /** Only labels of people already associated with this readable resource. */
  people?: Partial<Record<'owner' | 'createdBy' | 'updatedBy' | 'responsible', { name: string | null }>>;
  parentResourceRef?: string;
};

export type PluginWorkspaceCatalogTeamChoice = { teamId: string; label: string };
export type PluginWorkspaceCatalogResponse = {
  schemaVersion: 1;
  selection: PluginWorkspaceCatalogQuery & { selectionRequired: 'team' | null };
  items: PluginWorkspaceCatalogItem[];
  /** Browse choices describe current read access, never creation or management rights. */
  scopes: { choices: PluginWorkspaceCatalogScope[]; teams: PluginWorkspaceCatalogTeamChoice[] };
  pagination: { page: number; limit: number; totalItems: number; totalPages: number; hasNextPage: boolean; hasPreviousPage: boolean };
};

/** Server-derived projection context. Requested team IDs cannot populate this authority set. */
export type PluginWorkspaceCatalogScopeContext = {
  actorUserId: string;
  organizationAvailable: boolean;
  readableTeamIds: ReadonlySet<string>;
  teams: readonly PluginWorkspaceCatalogTeamChoice[];
};
