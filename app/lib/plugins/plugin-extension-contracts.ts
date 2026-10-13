import type { CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import type { CapabilityPackageStoreListResponse } from '@/app/lib/capabilities/packages/store-contracts';
import type { PluginWorkspaceCatalogItem, PluginWorkspaceCatalogResponse, PluginWorkspaceCatalogScope } from './plugin-workspace-catalog-contracts';

export type PluginExtensionKind = 'plugin' | 'skill' | 'integration' | 'mcp';
export type PluginExtensionStock = 'all' | 'installed' | 'available';
export type PluginExtensionSource = 'all' | 'store' | 'composio' | 'mcp';
export type PluginExtensionQuery = {
  q: string;
  types: PluginExtensionKind[];
  stock: PluginExtensionStock;
  source: PluginExtensionSource;
  scope: PluginWorkspaceCatalogScope;
  audience: 'own' | 'shared' | null;
  teamId: string | null;
  cursor: string | null;
  selected: string | null;
  limit: number;
};
export type PluginExtensionAccess = { canRead: boolean; canUse: boolean; canManage: boolean };
/** Management metadata is independent from provider reachability and agent permission. */
export type PluginExtensionConnection = {
  connectionRef: string;
  displayName: string;
  ownership: CapabilityResourceOwnerScope;
  ownershipLabel?: string;
  access: PluginExtensionAccess;
  authorization: 'authorized' | 'required' | 'unknown' | 'not_required';
  health: 'healthy' | 'unavailable' | 'unknown';
  checkedAt?: string | null;
  enabled: boolean;
  /** Only actor-owned personal profiles/accounts; shared backend identities stay private. */
  profileId?: string;
  accountId?: string;
};
export type PluginExtensionOffering = CapabilityPackageStoreListResponse['stores'][number]['offerings'][number];
type PluginExtensionItemBase = {
  id: string;
  kind: PluginExtensionKind;
  name: string;
  displayName: string;
  description: string;
  source: 'local' | 'store' | 'composio' | 'mcp';
  stock: 'installed' | 'available';
  access: PluginExtensionAccess;
  ownership?: CapabilityResourceOwnerScope;
  ownershipLabel?: string;
};
export type PluginExtensionItem = PluginExtensionItemBase & (
  | { kind: 'plugin' | 'skill'; package?: PluginWorkspaceCatalogItem; offering?: PluginExtensionOffering }
  | { kind: 'integration'; toolkit: { slug: string; noAuth: boolean }; connections: PluginExtensionConnection[] }
  | { kind: 'mcp'; mcp: { serverId?: string; connectionRef?: string; definitionId?: string; transport: 'http' | 'stdio' | 'unknown'; template: boolean }; connections: PluginExtensionConnection[] }
);
export type PluginExtensionCoverage = {
  source: 'packages' | 'store' | 'composio' | 'mcp';
  status: 'complete' | 'partial' | 'unavailable' | 'not_configured';
  error?: { code: string; message: string; retryable: boolean };
};
export type PluginExtensionSearchResponse = {
  schemaVersion: 1;
  query: PluginExtensionQuery;
  items: PluginExtensionItem[];
  selectedItem: PluginExtensionItem | null;
  scopes: PluginWorkspaceCatalogResponse['scopes'];
  coverage: PluginExtensionCoverage[];
  pagination: { nextCursor: string | null; hasNextPage: boolean; loadedItems: number; totalItems?: number };
};
