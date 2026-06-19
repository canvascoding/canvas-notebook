import 'server-only';

import { NextRequest } from 'next/server';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';

export async function requireMigrationAdmin(request: NextRequest) {
  return requireInstanceAdmin(request);
}
