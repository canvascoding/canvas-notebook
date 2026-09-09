// Shared by SQLite and PostgreSQL. Keep the oldest established link if a legacy
// installation has multiple active links for one path; never expose a new file.
export const PUBLIC_SHARE_UNIQUENESS_STATEMENTS = [
  `UPDATE public_file_shares SET status = 'revoked',
     revoked_reason = 'duplicate_active_link', policy_revision = policy_revision + 1
   WHERE id IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (
         PARTITION BY COALESCE(workspace_id, 'legacy-personal-workspace'), workspace_path
         ORDER BY created_at ASC, id ASC
       ) AS position
       FROM public_file_shares WHERE status = 'active'
     ) AS ranked WHERE position > 1
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_public_file_shares_active_path
   ON public_file_shares (COALESCE(workspace_id, 'legacy-personal-workspace'), workspace_path)
   WHERE status = 'active'`,
] as const;
