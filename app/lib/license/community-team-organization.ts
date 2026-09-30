import 'server-only';

import type { SqlConnection } from '@/app/lib/db';

export class CommunityTeamOrganizationError extends Error {
  readonly code = 'TEAM_SEAT_SUBJECT_CONFLICT';
  readonly status = 409;

  constructor() {
    super('Community Team v1 requires exactly one local organization.');
    this.name = 'CommunityTeamOrganizationError';
  }
}

export async function assertSingleCommunityTeamOrganization(
  database: Pick<SqlConnection, 'all'>,
): Promise<string> {
  const rows = await database.all(`
    SELECT organization_id
    FROM canvas_organization_settings
    ORDER BY organization_id ASC
    LIMIT 2
  `) as Array<{ organization_id: string }>;
  if (rows.length !== 1) throw new CommunityTeamOrganizationError();
  return rows[0].organization_id;
}
