import Module from 'node:module';

export type McpTestMembership = {
  organizationId: string;
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'suspended' | 'removed';
};

export type McpAccessMocks = {
  memberships: Map<string, McpTestMembership>;
  restore: () => void;
};

/**
 * Installs the only test doubles used by member-MCP tests. Product MCP access,
 * config, definition and manager modules remain real and are imported afterward.
 */
export function installMcpAccessMocks(): McpAccessMocks {
  const memberships = new Map<string, McpTestMembership>();
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request.includes('license/seat-limit')) {
      return {
        assertUserSeatAccess: async ({ userId }: { userId: string }) => {
          const membership = memberships.get(userId);
          if (!membership || membership.status !== 'active') {
            const error = new Error('Seat access is inactive.') as Error & { status: number };
            error.status = 403;
            throw error;
          }
          return { userId, mode: 'team', organizationId: membership.organizationId };
        },
      };
    }
    if (request.includes('organization/permissions')) {
      return {
        readOrganizationPermissionForUser: async (userId: string) => {
          const membership = memberships.get(userId);
          if (!membership) return { configured: false, organizationId: null, permission: null };
          return {
            configured: true,
            organizationId: membership.organizationId,
            permission: { role: membership.role, status: membership.status },
          };
        },
        assertUserOrganizationAdmin: async (userId: string) => {
          const membership = memberships.get(userId);
          if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) throw new Error('Admin required.');
        },
      };
    }
    if (request === 'server-only') return {};
    if (request === '@earendil-works/pi-agent-core') return {};
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return { isContextOverflow: () => false, getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    }
    if (request === '@earendil-works/pi-ai/oauth') return {};
    return originalLoad(request, parent, isMain);
  };
  return { memberships, restore: () => { moduleInternals._load = originalLoad; } };
}
