import 'server-only';

import path from 'node:path';
import { validateCanvasPluginPackage } from '@/app/lib/plugins/canvas-plugin-manifest';
import { parsePluginSkillsFromManifest } from '@/app/lib/plugins/canvas-plugin-registry';
import { parseSkillFile, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import type { WorkflowDeclaration } from '@/app/lib/capabilities/workflow-contracts';
import { CapabilityPackageError, type CapabilityPackagePublishedLocation } from './contracts';
import { normalizeCapabilityPackageRelativePath } from './io';

export type PackageExtensionSourceMetadata = {
  title: string; description: string; defaultPrompts: string[];
  skills: Array<{ skill: CanvasSkill; relativeRoot: string }>;
  declarations: WorkflowDeclaration[];
};

/** Only a verified, actor-authorized immutable location may be passed by the runtime reader. */
export async function readPackageExtensionSourceMetadata(location: CapabilityPackagePublishedLocation): Promise<PackageExtensionSourceMetadata> {
  if (location.kind === 'skill') {
    const skill = await parseSkillFile(path.join(location.rootPath, 'SKILL.md'));
    if (!skill || skill.name !== location.name) throw new CapabilityPackageError('PACKAGE_INVALID', 'The held skill identity is invalid.', 409);
    return { title: skill.title, description: skill.description, defaultPrompts: skill.interface?.defaultPrompt ? [skill.interface.defaultPrompt] : [],
      skills: [{ skill, relativeRoot: '' }], declarations: skill.workflow ? [{ declarationPath: 'agents/canvas.yaml', workflow: skill.workflow }] : [] };
  }
  const validated = await validateCanvasPluginPackage(location.rootPath);
  if (!validated.valid || !validated.manifest || validated.manifest.name !== location.name || validated.manifest.version !== location.version) {
    throw new CapabilityPackageError('PACKAGE_INVALID', 'The held plugin manifest is invalid.', 409);
  }
  const manifest = validated.manifest;
  const parsed = await parsePluginSkillsFromManifest(manifest, location.rootPath, validated.skillsDir);
  if (parsed.errors.length) throw new CapabilityPackageError('PACKAGE_INVALID', 'The held plugin skill inventory is invalid.', 409);
  const skills = parsed.skills.map(skill => {
    const relativeRoot = path.relative(location.rootPath, skill.directory).split(path.sep).join('/');
    if (relativeRoot) normalizeCapabilityPackageRelativePath(relativeRoot);
    if (path.resolve(skill.directory) !== path.join(path.resolve(location.rootPath), ...relativeRoot.split('/').filter(Boolean))) {
      throw new CapabilityPackageError('PACKAGE_INVALID', 'A held plugin skill escapes its published package.', 409);
    }
    return { skill, relativeRoot };
  });
  const declarations: WorkflowDeclaration[] = manifest.workflow ? [{ declarationPath: '.canvas-plugin/plugin.json', workflow: manifest.workflow }] : [];
  for (const child of skills) if (child.skill.workflow) declarations.push({
    declarationPath: child.relativeRoot ? `${child.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml', workflow: child.skill.workflow });
  return { title: manifest.interface?.displayName || manifest.name, description: manifest.interface?.shortDescription || manifest.description,
    defaultPrompts: [...(manifest.interface?.defaultPrompt ?? [])], skills, declarations };
}
