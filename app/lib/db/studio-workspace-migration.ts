export const STUDIO_WORKSPACE_TABLES = [
  'studio_products',
  'studio_personas',
  'studio_styles',
  'studio_presets',
  'studio_generations',
  'studio_bulk_jobs',
] as const;

function workspaceAssignmentSql(table: string, options: { hasVisibility?: boolean; presets?: boolean } = {}): string {
  const contentPredicate = options.presets ? 'COALESCE(is_default, 0) = 0' : '1 = 1';
  const organizationPredicate = options.hasVisibility
    ? "organization_id IS NOT NULL AND COALESCE(visibility, 'user') = 'organization'"
    : 'organization_id IS NOT NULL';

  return `
    UPDATE ${table}
    SET workspace_id = COALESCE(
      workspace_id,
      (
        SELECT w.id
        FROM canvas_workspaces w
        WHERE ${table}.project_id IS NOT NULL
          AND w.project_id = ${table}.project_id
          AND w.status = 'active'
        ORDER BY w.is_default DESC, w.created_at ASC, w.id ASC
        LIMIT 1
      ),
      (
        SELECT w.id
        FROM canvas_workspaces w
        WHERE ${organizationPredicate}
          AND w.organization_id = ${table}.organization_id
          AND w.type IN ('organization', 'team')
          AND w.status = 'active'
        ORDER BY CASE w.type WHEN 'organization' THEN 0 ELSE 1 END,
          w.is_default DESC,
          w.created_at ASC,
          w.id ASC
        LIMIT 1
      ),
      (
        SELECT w.id
        FROM canvas_workspaces w
        WHERE w.type = 'personal'
          AND w.owner_user_id = ${table}.user_id
          AND w.status = 'active'
        ORDER BY w.is_default DESC, w.created_at ASC, w.id ASC
        LIMIT 1
      ),
      (
        SELECT w.id
        FROM canvas_workspaces w
        WHERE ${table}.organization_id IS NOT NULL
          AND w.organization_id = ${table}.organization_id
          AND w.status = 'active'
        ORDER BY CASE w.type WHEN 'organization' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
          w.is_default DESC,
          w.created_at ASC,
          w.id ASC
        LIMIT 1
      )
    )
    WHERE workspace_id IS NULL
      AND ${contentPredicate}
  `;
}

function synchronizeWorkspaceFieldsSql(table: string, options: { presets?: boolean } = {}): string {
  const contentPredicate = options.presets ? 'COALESCE(is_default, 0) = 0' : '1 = 1';
  return `
    UPDATE ${table}
    SET
      organization_id = COALESCE((SELECT w.organization_id FROM canvas_workspaces w WHERE w.id = ${table}.workspace_id), organization_id),
      customer_id = (SELECT w.customer_id FROM canvas_workspaces w WHERE w.id = ${table}.workspace_id),
      project_id = (SELECT w.project_id FROM canvas_workspaces w WHERE w.id = ${table}.workspace_id)
    WHERE workspace_id IS NOT NULL
      AND ${contentPredicate}
  `;
}

export const STUDIO_WORKSPACE_BACKFILL_STATEMENTS = [
  workspaceAssignmentSql('studio_products', { hasVisibility: true }),
  workspaceAssignmentSql('studio_personas', { hasVisibility: true }),
  workspaceAssignmentSql('studio_styles', { hasVisibility: true }),
  workspaceAssignmentSql('studio_presets', { hasVisibility: true, presets: true }),
  workspaceAssignmentSql('studio_generations'),
  workspaceAssignmentSql('studio_bulk_jobs'),
  ...STUDIO_WORKSPACE_TABLES.map((table) => synchronizeWorkspaceFieldsSql(table, {
    presets: table === 'studio_presets',
  })),
  `
    UPDATE studio_products SET visibility = 'workspace' WHERE workspace_id IS NOT NULL
  `,
  `
    UPDATE studio_personas SET visibility = 'workspace' WHERE workspace_id IS NOT NULL
  `,
  `
    UPDATE studio_styles SET visibility = 'workspace' WHERE workspace_id IS NOT NULL
  `,
  `
    UPDATE studio_presets SET visibility = 'workspace' WHERE workspace_id IS NOT NULL AND COALESCE(is_default, 0) = 0
  `,
  `
    UPDATE studio_generation_outputs
    SET
      workspace_id = (SELECT g.workspace_id FROM studio_generations g WHERE g.id = studio_generation_outputs.generation_id),
      organization_id = (SELECT g.organization_id FROM studio_generations g WHERE g.id = studio_generation_outputs.generation_id),
      customer_id = (SELECT g.customer_id FROM studio_generations g WHERE g.id = studio_generation_outputs.generation_id),
      project_id = (SELECT g.project_id FROM studio_generations g WHERE g.id = studio_generation_outputs.generation_id),
      created_by_user_id = COALESCE(
        created_by_user_id,
        (SELECT COALESCE(g.created_by_user_id, g.user_id) FROM studio_generations g WHERE g.id = studio_generation_outputs.generation_id)
      )
    WHERE EXISTS (
      SELECT 1 FROM studio_generations g
      WHERE g.id = studio_generation_outputs.generation_id
        AND g.workspace_id IS NOT NULL
    )
  `,
] as const;
