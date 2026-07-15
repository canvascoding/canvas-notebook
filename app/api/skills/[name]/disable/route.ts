import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { refreshPersonalCapabilityRuntime } from '@/app/lib/capabilities/activation-actions';
import { requireActiveCapabilityUser } from '@/app/lib/capabilities/request-auth';
import { coreSkillInstallError, isCoreSkillName } from '@/app/lib/skills/core-skills';
import { disableSkillInConfig, resolveEnabledSkillNames } from '@/app/lib/skills/enabled-skills';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { readEnabledSkillsForScope, writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const capabilityUser = await requireActiveCapabilityUser(request);
    if (!capabilityUser.ok) return capabilityUser.response;

    const { name } = await params;
    if (isCoreSkillName(name)) {
      return NextResponse.json(
        { success: false, error: coreSkillInstallError(name) },
        { status: 409 },
      );
    }

    const scope = {
      scopeType: 'user' as const,
      userId: capabilityUser.session.user.id,
      organizationId: capabilityUser.state.organizationId,
    };
    
    const enabledSkills = await readEnabledSkillsForScope(scope);
    const allSkills = await loadSkillsFromDisk(undefined, scope);
    const allSkillNames = Array.from(new Set(allSkills.map((skill) => skill.name)));
    const nextEnabledSkills = disableSkillInConfig(name, enabledSkills, allSkillNames);

    if (JSON.stringify(nextEnabledSkills) !== JSON.stringify(enabledSkills || [])) {
      await writeEnabledSkillsForScope(nextEnabledSkills, {
        scope,
        updatedBy: capabilityUser.session.user.email || capabilityUser.session.user.id,
      });
      await refreshPersonalCapabilityRuntime(capabilityUser.session.user.id);
    }

    await recordAuditEvent({
      organizationId: capabilityUser.state.organizationId,
      userId: capabilityUser.session.user.id,
      source: 'skills',
      eventType: 'plugin',
      entityType: 'canvas_skill',
      entityId: name,
      action: 'skill.disable',
      status: 'success',
      summary: `Skill ${name} disabled.`,
      metadata: {
        skillName: name,
        scopeType: 'user',
      },
    });
    return NextResponse.json({
      success: true,
      message: `Skill "${name}" disabled`,
      name,
      enabledSkills: Array.from(resolveEnabledSkillNames(allSkillNames, nextEnabledSkills)),
    });
  } catch (error) {
    console.error('[Skills API] Error disabling skill:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to disable skill' },
      { status: 500 }
    );
  }
}
