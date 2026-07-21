import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { loadCapabilityCandidates, resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import {
  resolveCapabilityExecutionContextForUser,
  resolveCapabilityStorageScope,
} from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { parseSkillFile } from '@/app/lib/skills/canvas-skill-manifest';
import { loadSkillSummaries, matchesSkillSummaryQuery, type SkillSummary } from '@/app/lib/skills/skill-summaries';
import { readEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';
import { paginateItems, parsePositiveInteger } from '@/app/lib/utils/pagination';

const DEFAULT_SUMMARY_LIMIT = 50;
const MAX_SUMMARY_LIMIT = 100;

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const organizationState = await readOrganizationPermissionForUser(session.user.id);
    const scope = resolveCapabilityStorageScope({
      requestedScope: request.nextUrl.searchParams.get('scope'),
      userId: session.user.id,
      organizationState,
    });
    const summaryOnly = request.nextUrl.searchParams.get('summary') === '1';
    const enabledSkills = await readEnabledSkillsForScope(scope);
    let skills;
    if (scope.scopeType === 'organization') {
      const candidates = await loadCapabilityCandidates({
        organizationId: organizationState.organizationId!,
        userId: session.user.id,
        role: organizationState.permission?.role,
      }, { resolveConnections: false });
      const pluginNames = new Map(candidates
        .filter((candidate) => candidate.ref.resourceType === 'plugin')
        .map((candidate) => [candidate.ref.resourceId, candidate.ref]));
      skills = (await Promise.all(candidates
        .filter((candidate) => candidate.ref.resourceType === 'skill' && candidate.ref.scopeType === 'organization' && candidate.runtimePath)
        .map(async (candidate) => {
          const skill = await parseSkillFile(candidate.runtimePath!);
          if (!skill) return null;
          const plugin = candidate.pluginResourceId ? pluginNames.get(candidate.pluginResourceId) : null;
          return {
            ...skill,
            enabled: candidate.enabled,
            resourceId: candidate.ref.resourceId,
            scopeType: candidate.ref.scopeType,
            sourceType: candidate.ref.sourceType,
            revision: candidate.ref.revision,
            checksum: candidate.ref.checksum,
            plugin: plugin ? {
              name: plugin.name,
              version: plugin.version,
            } : skill.plugin,
          };
        }))).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
    } else if (organizationState.organizationId && organizationState.permission?.status === 'active') {
      const capabilityContext = await resolveCapabilityExecutionContextForUser({
        userId: session.user.id,
        organizationId: organizationState.organizationId,
        role: organizationState.permission.role,
        requestedWorkspaceId: request.nextUrl.searchParams.get('workspaceId'),
      });
      const snapshot = await resolveEffectiveCapabilitySnapshot(capabilityContext);
      const pluginNames = new Map(snapshot.capabilities
        .filter((entry) => entry.ref.resourceType === 'plugin')
        .map((entry) => [entry.ref.resourceId, entry.ref]));
      skills = (await Promise.all(snapshot.capabilities
        .filter((entry) => entry.ref.resourceType === 'skill' && entry.runtimePath)
        .map(async (entry) => {
          const skill = await parseSkillFile(entry.runtimePath!);
          if (!skill) return null;
          const plugin = entry.pluginResourceId ? pluginNames.get(entry.pluginResourceId) : null;
          return {
            ...skill,
            enabled: entry.effectiveEnabled,
            resourceId: entry.ref.resourceId,
            scopeType: entry.ref.scopeType,
            sourceType: entry.ref.sourceType,
            revision: entry.ref.revision,
            checksum: entry.ref.checksum,
            readiness: entry.readiness,
            effectivePolicy: entry.effectivePolicy,
            blockedReason: entry.blockedReason,
            conflictResourceIds: entry.conflictResourceIds,
            plugin: plugin ? {
              name: plugin.name,
              version: plugin.version,
            } : skill.plugin,
          };
        }))).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
    } else {
      skills = summaryOnly
        ? await loadSkillSummaries(enabledSkills, scope)
        : await (await import('@/app/lib/skills/skill-loader')).loadSkillsFromDisk(enabledSkills, scope);
    }
    const query = request.nextUrl.searchParams.get('query')?.trim().toLowerCase() || '';
    const enabledOnly = request.nextUrl.searchParams.get('enabledOnly') === '1';
    const paginated = summaryOnly && (
      query ||
      enabledOnly ||
      request.nextUrl.searchParams.has('page') ||
      request.nextUrl.searchParams.has('limit')
    );
    const filteredSkills = summaryOnly
      ? (skills as SkillSummary[])
        .filter((skill) => !enabledOnly || skill.enabled)
        .filter((skill) => matchesSkillSummaryQuery(skill, query))
      : skills;
    const page = parsePositiveInteger(request.nextUrl.searchParams.get('page'), 1);
    const limit = parsePositiveInteger(request.nextUrl.searchParams.get('limit'), DEFAULT_SUMMARY_LIMIT, MAX_SUMMARY_LIMIT);
    const pageResult = paginated ? paginateItems(filteredSkills, page, limit) : null;
    const responseSkills = pageResult ? pageResult.items : filteredSkills;
    const stats = {
      total: skills.length,
      enabled: skills.filter((skill) => skill.enabled).length,
      disabled: skills.filter((skill) => !skill.enabled).length,
    };

    return NextResponse.json({
      success: true,
      skills: responseSkills,
      stats,
      ...(pageResult ? { pagination: pageResult.pagination } : {}),
      scope: scope.scopeType,
      canManageOrganizationCapabilities: organizationState.permission?.status === 'active'
        && organizationState.permission.canSharePluginsAndSkills === true,
    });
  } catch (error) {
    console.error('[Skills API] Error loading skills:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skills' },
      { status: 500 }
    );
  }
}
