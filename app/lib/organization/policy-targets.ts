import 'server-only';

import { openDb } from '@/app/lib/db';

export type OrganizationPolicyTargetCatalog = {
  users: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    role: string;
  }>;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    type: string;
  }>;
  projects: Array<{
    projectId: string;
    name: string;
  }>;
};

export const EMPTY_ORGANIZATION_POLICY_TARGETS: OrganizationPolicyTargetCatalog = {
  users: [],
  workspaces: [],
  projects: [],
};

export async function listOrganizationPolicyTargets(
  organizationId: string,
): Promise<OrganizationPolicyTargetCatalog> {
  const database = await openDb();
  try {
    const users = await database.all(
      `SELECT
         p.user_id,
         u.name,
         u.email,
         p.role
       FROM organization_user_permissions p
       JOIN "user" u ON u.id = p.user_id
       WHERE p.organization_id = ?
         AND p.status = 'active'
         AND COALESCE(u.banned, 0) = 0
       ORDER BY lower(u.name) ASC, lower(u.email) ASC, p.user_id ASC`,
      [organizationId],
    ) as Array<{
      user_id: string;
      name: string | null;
      email: string | null;
      role: string;
    }>;
    const workspaces = await database.all(
      `SELECT id, display_name, type
       FROM canvas_workspaces
       WHERE organization_id = ? AND status = 'active'
       ORDER BY lower(display_name) ASC, id ASC`,
      [organizationId],
    ) as Array<{
      id: string;
      display_name: string;
      type: string;
    }>;
    const projects = await database.all(
      `SELECT id, name
       FROM canvas_projects
       WHERE organization_id = ? AND status = 'active'
       ORDER BY lower(name) ASC, id ASC`,
      [organizationId],
    ) as Array<{
      id: string;
      name: string;
    }>;

    return {
      users: users.map((user) => ({
        userId: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
      })),
      workspaces: workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.display_name,
        type: workspace.type,
      })),
      projects: projects.map((project) => ({
        projectId: project.id,
        name: project.name,
      })),
    };
  } finally {
    await database.close();
  }
}
