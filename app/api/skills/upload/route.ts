import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { getSkillsDir, parseFrontmatter, validateFrontmatter } from '@/app/lib/skills/canvas-skill-manifest';
import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import { enableSkillInConfig } from '@/app/lib/skills/enabled-skills';
import { getSkillNames } from '@/app/lib/skills/skill-loader';

const SKILLS_DIR = getSkillsDir();

function sanitizeSkillName(name: string): string {
  return name.replace(/[^a-z0-9-]/g, '');
}

export async function POST(request: Request) {
  const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!skillPermission.ok) return skillPermission.response;

  try {
    const body = await request.json();
    const { content, name: providedName } = body;

    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'SKILL.md content is required' },
        { status: 400 }
      );
    }

    const { frontmatter, body: _skillBody } = parseFrontmatter(content);

    if (!frontmatter) {
      return NextResponse.json(
        {
          success: false,
          error: 'No valid YAML frontmatter found. SKILL.md must start with --- delimiters.',
          validation: { valid: false, errors: ['No valid YAML frontmatter found'], warnings: [] },
        },
        { status: 400 }
      );
    }

    const validation = validateFrontmatter(frontmatter);

    if (!validation.valid) {
      return NextResponse.json(
        {
          success: false,
          error: 'Skill validation failed',
          validation,
        },
        { status: 400 }
      );
    }

    const skillName = sanitizeSkillName(providedName || frontmatter.name);

    if (!skillName) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name. Must be lowercase letters, numbers, and hyphens.' },
        { status: 400 }
      );
    }

    if (skillName.length > 64) {
      return NextResponse.json(
        { success: false, error: 'Skill name too long. Maximum is 64 characters.' },
        { status: 400 }
      );
    }

    const skillDir = path.join(SKILLS_DIR, skillName);
    const resolvedSkillDir = path.resolve(skillDir);
    const resolvedSkillsDir = path.resolve(SKILLS_DIR);
    if (!resolvedSkillDir.startsWith(`${resolvedSkillsDir}${path.sep}`)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name: path traversal detected' },
        { status: 400 }
      );
    }

    const skillMdPath = path.join(skillDir, 'SKILL.md');

    const existingContent = await fs.readFile(skillMdPath, 'utf-8').catch(() => null);
    if (existingContent) {
      return NextResponse.json(
        { success: false, error: `Skill "${skillName}" already exists. Use the skill editor to modify it.` },
        { status: 409 }
      );
    }

    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillMdPath, content, 'utf-8');

    try {
      const config = await readPiRuntimeConfig();
      const allSkillNames = await getSkillNames();
      config.enabledSkills = enableSkillInConfig(skillName, config.enabledSkills, allSkillNames);
      await writePiRuntimeConfig(config);
    } catch (cfgError) {
      console.warn('[Skills Upload API] Could not auto-enable skill:', skillName, cfgError);
    }

    console.log(`[Skills Upload API] Created skill: ${skillDir}`);

    return NextResponse.json({
      success: true,
      name: skillName,
      path: skillMdPath,
      validation,
    });
  } catch (error) {
    console.error('[Skills Upload API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to upload skill' },
      { status: 500 }
    );
  }
}
