export const TEAM_MEMBERSHIP_SUSPENSION_BAN_PREFIX = 'canvas_team_membership_suspended:';
export const TEAM_LICENSE_FALLBACK_BAN_REASON = 'canvas_team_license_fallback';

export function isTeamMembershipReactivationBanReason(
  banReason: string | null | undefined,
): boolean {
  return banReason === TEAM_LICENSE_FALLBACK_BAN_REASON
    || banReason?.startsWith(TEAM_MEMBERSHIP_SUSPENSION_BAN_PREFIX) === true;
}
