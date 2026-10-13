/** V1 pins package workflows; V2 also supports exact standalone extensions. */
export type ExplicitAgentWorkflowVersion = 1 | 2;
export type AgentWorkflowVersion = ExplicitAgentWorkflowVersion | null;

export function isExplicitAgentWorkflowVersion(value: unknown): value is ExplicitAgentWorkflowVersion {
  return value === 1 || value === 2;
}

/**
 * Decode actual SQL values. Only SQL NULL denotes legacy inheritance; an
 * unsupported or missing version must never silently fall back to inheritance.
 * PostgreSQL bigint values can arrive as their canonical decimal strings.
 */
export function parseStoredAgentWorkflowHeader(version: unknown, revision: unknown): Readonly<{
  workflowVersion: AgentWorkflowVersion;
  workflowRevision: number;
}> {
  const parsedVersion = version === '1' ? 1 : version === '2' ? 2 : version;
  const parsedRevision = typeof revision === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(revision)
    ? Number(revision) : revision;
  if (parsedVersion !== null && !isExplicitAgentWorkflowVersion(parsedVersion)
    || typeof parsedRevision !== 'number' || !Number.isSafeInteger(parsedRevision)
    || parsedRevision < 0 || parsedVersion !== null && parsedRevision < 1) {
    throw new Error('The stored agent workflow header cannot be verified.');
  }
  return Object.freeze({ workflowVersion: parsedVersion as AgentWorkflowVersion, workflowRevision: parsedRevision });
}
