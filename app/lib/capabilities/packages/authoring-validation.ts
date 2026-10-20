import 'server-only';

import path from 'node:path';
import { validateCreatorPluginManifest } from '@/app/lib/plugins/creator-plugin-manifest';
import { isValidCanvasPluginVersion } from '@/app/lib/plugins/canvas-plugin-manifest';
import { parseSkillFile } from '@/app/lib/skills/canvas-skill-manifest';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import { isCapabilityPackageError, type CapabilityPackageDraft, type CapabilityPackageDraftLocation } from './contracts';
import { validateCapabilityPackage } from './artifacts';
import { normalizeCapabilityPackageRelativePath, readCapabilityPackageFile, readExactPackageInventory } from './io';
import { CAPABILITY_PACKAGE_ICON_MAX_BYTES } from './package-icon-image';
import { validateCreatorPluginSvg } from './creator-plugin-svg';
import { assertPortableFiles, PortablePackageDeclarationError } from './portable-declarations';
import type { CapabilityPackageDraftValidationReport, CapabilityPackageValidationIssue } from './validation-contracts';

const manifestPath = '.canvas-plugin/plugin.json';
const manifestMaxBytes = 256 * 1024;

/** Shared by explicit Validate and final Publish while holding the actual draft/SQL authority. */
export async function validateCapabilityPackageDraftContents(draft: CapabilityPackageDraft, location: CapabilityPackageDraftLocation,
  creatorContract: boolean): Promise<CapabilityPackageDraftValidationReport> {
  const inventory = await readExactPackageInventory(location.rootPath);
  const issues: CapabilityPackageValidationIssue[] = [];
  const add = (code: string, file: string, field: string, message: string, repair: string) => issues.push({ code, file, field, message, repair });
  const validation = await validateCapabilityPackage(draft.kind, location.rootPath, { name: draft.name });
  if (creatorContract && draft.kind === 'plugin') {
    const entry = inventory.files.find(file => file.relativePath === manifestPath);
    if (!entry) add('MANIFEST_MISSING', manifestPath, '$', 'The plugin manifest is missing.', 'Create the canonical plugin manifest.');
    else if (entry.size > manifestMaxBytes) add('MANIFEST_TOO_LARGE', manifestPath, '$', 'The plugin manifest exceeds 256 KiB.', 'Keep package files outside the manifest.');
    else {
      const file = await readCapabilityPackageFile(location, { path: manifestPath, maxBytes: manifestMaxBytes });
      const parsed = validateCreatorPluginManifest(Buffer.from(file.content, 'base64').toString('utf8'));
      issues.push(...parsed.issues.map(issue => ({ code: issue.code, file: manifestPath, field: issue.path || '$', message: issue.message, repair: issue.repair })));
      if (parsed.valid && parsed.manifest) {
        try {
          assertPortableFiles(new Map(inventory.files.map(file => [file.relativePath, { path: file.relativePath, bytes: file.bytes, executable: file.executable }])), parsed.manifest.connectors?.mcp);
        } catch (error) {
          if (!isCapabilityPackageError(error) || error.code !== 'PACKAGE_INVALID') throw error;
          add('PACKAGE_DECLARATION_NOT_PORTABLE', error instanceof PortablePackageDeclarationError ? error.file : manifestPath,
            error instanceof PortablePackageDeclarationError ? error.field : 'connectors', error.message,
            'Keep portable configuration and central ENV placeholders only; remove account, profile, connection and credential values.');
        }
        const logo = normalizeCapabilityPackageRelativePath(parsed.manifest.interface.logo.replace(/^\.\//u, ''));
        const image = inventory.files.find(file => file.relativePath === logo);
        if (!image) add('SVG_MISSING', logo, 'interface.logo', 'The declared purpose graphic is missing.', 'Create this local SVG or correct interface.logo.');
        else if (image.size > CAPABILITY_PACKAGE_ICON_MAX_BYTES) add('SVG_TOO_LARGE', logo, 'interface.logo', 'The purpose graphic exceeds 2 MiB.', 'Simplify the SVG and save it below 2 MiB.');
        else {
          const imageFile = await readCapabilityPackageFile(location, { path: logo, maxBytes: CAPABILITY_PACKAGE_ICON_MAX_BYTES });
          issues.push(...validateCreatorPluginSvg(Buffer.from(imageFile.content, 'base64'), logo));
        }
        const skillRoot = parsed.manifest.skills === '.' ? '' : normalizeCapabilityPackageRelativePath(parsed.manifest.skills.replace(/^\.\//u, ''));
        const skillPrefix = skillRoot ? `${skillRoot}/` : '';
        const skillFiles = inventory.files.filter(file => file.relativePath.startsWith(skillPrefix) && path.posix.basename(file.relativePath) === 'SKILL.md');
        if (!skillFiles.length) add('SKILL_MISSING', `${skillPrefix}SKILL.md`, 'skills', 'The plugin contains no bundled skill.', 'Create at least one complete child SKILL.md under the declared skills directory.');
        for (const skillFile of skillFiles) {
          const diagnostics: string[] = [];
          const skill = await parseSkillFile(requirePathInside(location.rootPath, skillFile.relativePath), {
            validateDirectoryName: skillFile.relativePath !== 'SKILL.md', onDiagnostic: message => diagnostics.push(message.replaceAll(location.rootPath, 'package')),
          });
          if (!skill) add('SKILL_INVALID', skillFile.relativePath, 'frontmatter', diagnostics.join(' ') || 'The child skill is invalid.', 'Repair the skill frontmatter and its declared references.');
          else if (!skill.version || !isValidCanvasPluginVersion(skill.version)) add('SKILL_VERSION_REQUIRED', skillFile.relativePath, 'metadata.version',
            'The child skill needs an independent valid version.', 'Declare a valid metadata.version in this child SKILL.md or its agents/canvas.yaml.');
        }
      }
    }
  }
  if (!validation.valid) {
    for (const message of validation.errors) add('PACKAGE_CONTENT_INVALID', draft.kind === 'plugin' ? manifestPath : 'SKILL.md', 'package', message,
      'Repair the indicated package declaration, bundled skill or connector reference and validate the current revision again.');
  }
  const after = await readExactPackageInventory(location.rootPath);
  if (after.checksum !== inventory.checksum) add('PACKAGE_CHANGED', draft.kind === 'plugin' ? manifestPath : 'SKILL.md', 'package',
    'The package bytes changed during validation.', 'Reload the draft and validate its current revision.');
  return { ...validation, valid: validation.valid && issues.length === 0, checksum: after.checksum,
    files: after.files.map(file => ({ path: file.relativePath, size: file.size, checksum: file.checksum })), totalBytes: after.totalBytes,
    errors: issues.map(issue => `${issue.file} (${issue.field}): ${issue.message}`),
    validationVersion: 1, draftRevision: draft.draftRevision, manifestSchemaVersion: creatorContract && draft.kind === 'plugin' ? 1 : null, issues };
}
