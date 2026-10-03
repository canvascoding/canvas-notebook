import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { getUserPreferences } from '@/app/lib/user-preferences';

export type TeamLicenseAttentionItem = {
  id: string;
  type: 'license.team_access_changed' | 'license.team_grant_expiring';
  title: string;
  detail: string;
  previewUrl: null;
  occurredAt: string;
  unread: boolean;
  priority: 'high' | 'normal';
  workspaceId: string;
  workspaceName: string;
  target: { kind: 'license' };
};

type LifecycleAuditRow = {
  id: string;
  organization_id: string;
  owner_user_id: string | null;
  action: string;
  metadata_json: string | null;
  created_at: number | string;
  read_at: number | string | null;
};

type AttentionOptions = {
  database?: Pick<SqlConnection, 'all' | 'run' | 'close'>;
  enabled?: boolean;
  locale?: string;
  activeOnly?: boolean;
};

function activeLicenseRows(rows: LifecycleAuditRow[]): LifecycleAuditRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;
    const warning = row.action.startsWith('team.grant_expiring_')
      || row.action === 'team.owner_grace' || row.action === 'team.member_grace';
    const correlated = typeof metadata.instanceId === 'string' && typeof metadata.grantId === 'string';
    const key = warning
      ? correlated ? JSON.stringify([row.organization_id, 'grant', metadata.instanceId, metadata.grantId, metadata.termEndsAt])
        : JSON.stringify([row.organization_id, 'uncorrelated-warning', row.id])
      : JSON.stringify([row.organization_id, 'access']);
    if (seen.has(key)) return false;
    seen.add(key);
    // Supersede before filtering read state: reading the newest event cannot revive an older one.
    return row.read_at === null;
  });
}

function hasMembershipTransition(row: LifecycleAuditRow): boolean {
  try {
    const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;
    if (/^team\.grant_expiring_(14|3|1)d$/u.test(row.action)) {
      return typeof metadata.termEndsAt === 'string'
        && Number.isFinite(Date.parse(metadata.termEndsAt));
    }
    if (row.action === 'team.owner_grace' || row.action === 'team.member_grace') {
      return typeof metadata.graceEndsAt === 'string'
        && Number.isFinite(Date.parse(metadata.graceEndsAt));
    }
    const field = row.action === 'team.access_restored' ? 'restoredMemberships' : 'suspendedMemberships';
    return Number(metadata[field]) > 0;
  } catch {
    return false;
  }
}

export async function listTeamLicenseAttention(
  input: { userId: string } & AttentionOptions,
): Promise<TeamLicenseAttentionItem[]> {
  const preferences = input.enabled === undefined ? await getUserPreferences(input.userId) : null;
  if ((input.enabled ?? preferences?.teamLicenseNotificationsEnabled ?? true) === false) return [];
  const locale = input.locale ?? preferences?.locale ?? 'en';
  const german = locale.toLowerCase().startsWith('de');
  const database = input.database ?? await openDb();
  try {
    const rows = await database.all(`
      SELECT event.id, event.organization_id, organization.owner_user_id, event.action, event.metadata_json,
        event.created_at, read_state.read_at
      FROM audit_events event
      INNER JOIN canvas_organization_settings organization
        ON organization.organization_id = event.organization_id
      LEFT JOIN mobile_inbox_read_states read_state
        ON read_state.user_id = $1
        AND read_state.workspace_id = 'organization:' || event.organization_id
        AND read_state.item_key = 'license:' || event.id
      WHERE event.user_id = $1 AND event.source = 'license'
        AND event.event_type IN ('license_lifecycle', 'license_term_warning') AND event.status = 'success'
        AND event.action IN ('team.solo_fallback_applied', 'team.seat_limit_enforced', 'team.access_restored',
          'team.grant_expiring_14d', 'team.grant_expiring_3d', 'team.grant_expiring_1d',
          'team.owner_grace', 'team.member_grace')
        AND (organization.owner_user_id = $1 OR (event.event_type = 'license_term_warning'
          AND EXISTS (SELECT 1 FROM team_memberships membership
            WHERE membership.organization_id = event.organization_id
              AND membership.user_id = $1 AND membership.status = 'active'
              AND membership.role <> 'owner')))
        AND ($2 = false OR NOT EXISTS (SELECT 1 FROM audit_events resolution
          WHERE resolution.entity_id = event.id AND resolution.organization_id = event.organization_id
            AND resolution.user_id = event.user_id AND resolution.source = 'license'
            AND resolution.status = 'success' AND resolution.event_type = 'license_term_warning_resolved'))
      ORDER BY event.created_at DESC, event.id DESC
      LIMIT 50
    `, [input.userId, input.activeOnly === true]) as LifecycleAuditRow[];
    const validRows = rows.filter(hasMembershipTransition);
    return (input.activeOnly ? activeLicenseRows(validRows) : validRows).map((row) => {
      const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;
      const warningDays = Number(row.action.match(/^team\.grant_expiring_(14|3|1)d$/u)?.[1]);
      const warning = Number.isFinite(warningDays);
      const memberWarning = warning && row.owner_user_id !== input.userId;
      const graceWarning = row.action === 'team.owner_grace' || row.action === 'team.member_grace';
      const ownerGraceWarning = row.action === 'team.owner_grace';
      const restored = row.action === 'team.access_restored';
      const partialRestore = restored && (Number(metadata.remainingFallbackUsers) > 0
        || Number(metadata.suspendedMemberships) > 0);
      const expired = !restored && row.action === 'team.solo_fallback_applied';
      return {
        id: `license:${row.id}`,
        type: warning || graceWarning ? 'license.team_grant_expiring' as const : 'license.team_access_changed' as const,
        title: graceWarning
          ? german ? 'Team-Zugang endet bald' : 'Team access ends soon'
          : warning
          ? german ? `Team-Grant endet in ${warningDays} ${warningDays === 1 ? 'Tag' : 'Tagen'}`
            : `Team grant ends within ${warningDays} ${warningDays === 1 ? 'day' : 'days'}`
          : partialRestore
          ? german ? 'Team-Zugang teilweise wiederhergestellt' : 'Team access partially restored'
          : restored
          ? german ? 'Team-Zugang wiederhergestellt' : 'Team access restored'
          : expired
            ? german ? 'Team-Zugang durch Lizenz-Fallback pausiert' : 'Team access paused by license fallback'
            : german ? 'Team-Zugang durch Seat-Limit reduziert' : 'Team access reduced by seat limit',
        detail: graceWarning
          ? ownerGraceWarning
            ? german ? 'Dein Team-Grant ist abgelaufen. Während der Schonfrist bleiben bestehende Zugänge aktiv. Verlängere den Grant im Control Plane, bevor Mitglieder den Zugang verlieren.'
              : 'Your Team grant has expired. Existing access remains active during the grace period. Renew the grant in Control Plane before members lose access.'
            : german ? 'Die Team-Lizenz ist abgelaufen. Während der Schonfrist bleibt dein Zugang verfügbar; danach kann er pausiert werden. Wende dich an den Organisations-Owner.'
              : 'The team license has expired. Access remains available during the grace period; afterward it may be paused. Contact the organization owner.'
          : warning
          ? memberWarning
            ? german ? 'Die Team-Lizenz endet bald. Dein Zugang kann danach eingeschränkt werden. Wende dich an den Organisations-Owner.'
              : 'The team license ends soon. Your access may be restricted afterward. Contact the organization owner.'
            : german ? 'Verlängere den kostenfreien Grant im Control Plane, damit der Team-Zugang bestehen bleibt.'
              : 'Renew the free grant in Control Plane to keep Team access available.'
          : partialRestore
          ? german ? 'Einige Teammitglieder können sich wieder anmelden. Weitere Zugänge bleiben eingeschränkt. Prüfe die Team-Lizenz.'
            : 'Some team members can sign in again. Other access remains restricted. Review the team license.'
          : restored
          ? german ? 'Betroffene Teammitglieder können sich wieder anmelden.' : 'Affected team members can sign in again.'
          : german ? 'Betroffene Teammitglieder können sich derzeit nicht anmelden. Prüfe die Team-Lizenz.'
            : 'Affected team members cannot sign in right now. Review the team license.',
        previewUrl: null,
        occurredAt: new Date(Number(row.created_at)).toISOString(),
        unread: row.read_at === null,
        priority: restored && !partialRestore ? 'normal' as const : 'high' as const,
        workspaceId: `organization:${row.organization_id}`,
        workspaceName: german ? 'Organisation' : 'Organization',
        target: { kind: 'license' as const },
      };
    });
  } finally {
    if (!input.database) await database.close();
  }
}

export async function markTeamLicenseAttentionRead(
  input: { userId: string; itemId?: string } & AttentionOptions,
): Promise<{ updated: number; found: boolean }> {
  const items = await listTeamLicenseAttention(input);
  const selected = input.itemId ? items.filter((item) => item.id === input.itemId) : items.filter((item) => item.unread);
  if (selected.length === 0) return { updated: 0, found: !input.itemId };
  const database = input.database ?? await openDb();
  try {
    const now = Date.now();
    for (const item of selected) {
      await database.run(`
        INSERT INTO mobile_inbox_read_states
          (user_id, workspace_id, item_key, read_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4, $4)
        ON CONFLICT (user_id, workspace_id, item_key)
        DO UPDATE SET read_at = EXCLUDED.read_at, updated_at = EXCLUDED.updated_at
      `, [input.userId, item.workspaceId, item.id, now]);
    }
    return { updated: selected.length, found: true };
  } finally {
    if (!input.database) await database.close();
  }
}
