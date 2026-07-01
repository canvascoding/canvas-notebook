import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import {
  getOrganizationBootstrapStatus,
  openOrganizationBootstrapDatabase,
  OrganizationBootstrapError,
} from '@/app/lib/organization/bootstrap';
import { getPostgresOrganizationBootstrapStatus } from '@/app/lib/workspaces/postgres-runtime';

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  try {
    if (getDatabaseProvider() === 'postgres') {
      const status = await getPostgresOrganizationBootstrapStatus();
      return NextResponse.json({ success: true, data: status });
    }

    const sqlite = openOrganizationBootstrapDatabase();
    try {
      const status = getOrganizationBootstrapStatus(sqlite);
      return NextResponse.json({ success: true, data: status });
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof OrganizationBootstrapError) {
      const status = error.code === 'ORGANIZATION_ID_CONFLICT' ? 409 : 400;
      return NextResponse.json(
        { success: false, code: error.code, error: error.message },
        { status },
      );
    }

    console.error('[admin/organization/status] Failed to resolve organization status:', error);
    return NextResponse.json(
      { success: false, code: 'DATABASE_ERROR', error: 'Could not resolve organization status.' },
      { status: 500 },
    );
  }
}
