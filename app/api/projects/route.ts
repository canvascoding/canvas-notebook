import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import {
  ensureOrganizationBootstrapForUser,
  openOrganizationBootstrapDatabase,
} from '@/app/lib/organization/bootstrap';
import { areProjectFeaturesEnabled } from '@/app/lib/projects/features';
import { createCanvasProject, listCanvasProjects, normalizeSlug } from '@/app/lib/projects/service';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { getPostgresWorkspaceState } from '@/app/lib/workspaces/postgres-runtime';

function projectFeatureDisabledResponse() {
  return NextResponse.json(
    { success: false, error: 'Project features are not enabled.', code: 'PROJECT_FEATURE_DISABLED' },
    { status: 501 },
  );
}

function assertAdminActor(actor: ReturnType<typeof resolveWorkspaceActor>) {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Admin permission required.', code: 'PROJECT_PERMISSION_DENIED' },
      { status: 403 },
    );
  }
  return null;
}

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error('Name is required.');
  if (name.length > 120) throw new Error('Name must be 120 characters or fewer.');
  return name;
}

export async function GET(request: NextRequest) {
  try {
    if (!areProjectFeaturesEnabled()) return projectFeatureDisabledResponse();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const actor = resolveWorkspaceActor({ id: session.user.id, email: session.user.email, role: session.user.role });
    const permissionResponse = assertAdminActor(actor);
    if (permissionResponse) return permissionResponse;

    if (getDatabaseProvider() === 'postgres') {
      const state = await getPostgresWorkspaceState(actor);
      if (!state.status.organizationId) {
        return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
      }
      const database = await openDb();
      try {
        const projects = await database.all(
          `
            SELECT
              p.id,
              p.organization_id AS "organizationId",
              p.customer_id AS "customerId",
              p.name,
              p.slug,
              p.status,
              p.description,
              p.metadata_json AS "metadataJson",
              p.created_by_user_id AS "createdByUserId",
              p.archived_at AS "archivedAt",
              p.created_at AS "createdAt",
              p.updated_at AS "updatedAt",
              w.id AS "workspaceId"
            FROM canvas_projects p
            LEFT JOIN canvas_workspaces w
              ON w.organization_id = p.organization_id
              AND w.project_id = p.id
              AND w.type = 'project'
              AND w.status = 'active'
            WHERE p.organization_id = ? AND p.status = 'active'
            ORDER BY lower(p.name) ASC, p.created_at ASC
          `,
          [state.status.organizationId],
        );
        return NextResponse.json({ success: true, projects });
      } finally {
        await database.close();
      }
    }

    const sqlite = openOrganizationBootstrapDatabase();
    try {
      const status = ensureOrganizationBootstrapForUser(sqlite, session.user.id);
      if (!status.organizationId) {
        return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
      }
      const projects = listCanvasProjects(sqlite, status.organizationId).map((project) => {
        const workspace = sqlite.prepare(`
          SELECT id
          FROM canvas_workspaces
          WHERE organization_id = ? AND project_id = ? AND type = 'project' AND status = 'active'
          LIMIT 1
        `).get(status.organizationId, project.id) as { id: string } | undefined;
        return { ...project, workspaceId: workspace?.id ?? null };
      });
      return NextResponse.json({ success: true, projects });
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return jsonServerError('[API] Projects get error:', error, 'Could not load projects');
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!areProjectFeaturesEnabled()) return projectFeatureDisabledResponse();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const actor = resolveWorkspaceActor({ id: session.user.id, email: session.user.email, role: session.user.role });
    const permissionResponse = assertAdminActor(actor);
    if (permissionResponse) return permissionResponse;
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const name = normalizeName(payload.name);
    const customerId = typeof payload.customerId === 'string' && payload.customerId.trim()
      ? payload.customerId.trim()
      : null;

    if (getDatabaseProvider() === 'postgres') {
      const state = await getPostgresWorkspaceState(actor);
      if (!state.status.organizationId) {
        return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
      }
      const database = await openDb();
      try {
        if (customerId) {
          const customer = await database.get(
            'SELECT id FROM canvas_customers WHERE organization_id = ? AND id = ? AND status = ? LIMIT 1',
            [state.status.organizationId, customerId, 'active'],
          ) as { id: string } | undefined;
          if (!customer) {
            return NextResponse.json({ success: false, error: 'Customer not found.', code: 'PROJECT_CUSTOMER_NOT_FOUND' }, { status: 404 });
          }
        }

        const now = Date.now();
        const id = `prj_${randomUUID()}`;
        const baseSlug = normalizeSlug(typeof payload.slug === 'string' ? payload.slug : name);
        const rows = await database.all(
          'SELECT slug FROM canvas_projects WHERE organization_id = ? AND (slug = ? OR slug LIKE ?)',
          [state.status.organizationId, baseSlug, `${baseSlug}-%`],
        ) as Array<{ slug: string }>;
        const used = new Set(rows.map((row) => row.slug));
        let slug = baseSlug;
        for (let index = 2; used.has(slug); index += 1) slug = `${baseSlug}-${index}`;
        await database.run(
          `
            INSERT INTO canvas_projects (
              id, organization_id, customer_id, name, slug, status, description, metadata_json, created_by_user_id, archived_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)
          `,
          [
            id,
            state.status.organizationId,
            customerId,
            name,
            slug,
            typeof payload.description === 'string' ? payload.description : null,
            typeof payload.metadataJson === 'string' ? payload.metadataJson : null,
            actor.userId,
            now,
            now,
          ],
        );
        return NextResponse.json({ success: true, project: { id, organizationId: state.status.organizationId, customerId, name, slug } }, { status: 201 });
      } finally {
        await database.close();
      }
    }

    const sqlite = openOrganizationBootstrapDatabase();
    try {
      const status = ensureOrganizationBootstrapForUser(sqlite, session.user.id);
      if (!status.organizationId) {
        return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
      }
      const project = createCanvasProject(sqlite, {
        organizationId: status.organizationId,
        name,
        slug: typeof payload.slug === 'string' ? payload.slug : undefined,
        customerId,
        description: typeof payload.description === 'string' ? payload.description : null,
        metadataJson: typeof payload.metadataJson === 'string' ? payload.metadataJson : null,
        createdByUserId: actor.userId,
      });
      return NextResponse.json({ success: true, project }, { status: 201 });
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof Error && /Name/u.test(error.message)) {
      return NextResponse.json({ success: false, error: error.message, code: 'PROJECT_NAME_INVALID' }, { status: 400 });
    }
    return jsonServerError('[API] Projects create error:', error, 'Could not create project');
  }
}
