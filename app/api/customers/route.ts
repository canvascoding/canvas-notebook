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
import { createCanvasCustomer, listCanvasCustomers, normalizeSlug } from '@/app/lib/projects/service';
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
        const customers = await database.all(
          `
            SELECT id, organization_id AS "organizationId", name, slug, status, notes, metadata_json AS "metadataJson",
              created_by_user_id AS "createdByUserId", created_at AS "createdAt", updated_at AS "updatedAt"
            FROM canvas_customers
            WHERE organization_id = ? AND status = 'active'
            ORDER BY lower(name) ASC, created_at ASC
          `,
          [state.status.organizationId],
        );
        return NextResponse.json({ success: true, customers });
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
      return NextResponse.json({ success: true, customers: listCanvasCustomers(sqlite, status.organizationId) });
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return jsonServerError('[API] Customers get error:', error, 'Could not load customers');
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

    if (getDatabaseProvider() === 'postgres') {
      const state = await getPostgresWorkspaceState(actor);
      if (!state.status.organizationId) {
        return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
      }
      const database = await openDb();
      try {
        const now = Date.now();
        const id = `cust_${randomUUID()}`;
        const baseSlug = normalizeSlug(typeof payload.slug === 'string' ? payload.slug : name);
        const rows = await database.all(
          'SELECT slug FROM canvas_customers WHERE organization_id = ? AND (slug = ? OR slug LIKE ?)',
          [state.status.organizationId, baseSlug, `${baseSlug}-%`],
        ) as Array<{ slug: string }>;
        const used = new Set(rows.map((row) => row.slug));
        let slug = baseSlug;
        for (let index = 2; used.has(slug); index += 1) slug = `${baseSlug}-${index}`;
        await database.run(
          `
            INSERT INTO canvas_customers (
              id, organization_id, name, slug, status, notes, metadata_json, created_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
          `,
          [
            id,
            state.status.organizationId,
            name,
            slug,
            typeof payload.notes === 'string' ? payload.notes : null,
            typeof payload.metadataJson === 'string' ? payload.metadataJson : null,
            actor.userId,
            now,
            now,
          ],
        );
        return NextResponse.json({ success: true, customer: { id, organizationId: state.status.organizationId, name, slug } }, { status: 201 });
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
      const customer = createCanvasCustomer(sqlite, {
        organizationId: status.organizationId,
        name,
        slug: typeof payload.slug === 'string' ? payload.slug : undefined,
        notes: typeof payload.notes === 'string' ? payload.notes : null,
        metadataJson: typeof payload.metadataJson === 'string' ? payload.metadataJson : null,
        createdByUserId: actor.userId,
      });
      return NextResponse.json({ success: true, customer }, { status: 201 });
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof Error && /Name/u.test(error.message)) {
      return NextResponse.json({ success: false, error: error.message, code: 'PROJECT_NAME_INVALID' }, { status: 400 });
    }
    return jsonServerError('[API] Customers create error:', error, 'Could not create customer');
  }
}
