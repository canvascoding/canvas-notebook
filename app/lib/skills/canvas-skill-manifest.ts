import { promises as fs } from 'fs';
import path from 'path';
import YAML from 'yaml';

import {
  resolveScopedSkillsDataDir,
  type UserScopedDataStorageScope,
} from '@/app/lib/runtime-data-paths';
import { requirePathInside } from '@/app/lib/security/safe-paths';

export { getSkillsContext } from './skill-context';

export const CANVAS_SKILL_INTERFACE_PATH = path.join('agents', 'canvas.yaml');

export interface CanvasSkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  'allowed-tools'?: string;
  metadata?: Record<string, string>;
}

export interface CanvasSkillInterface {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
  version?: string;
}

export interface CanvasSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  version?: string;
  title: string;
  content: string;
  path: string;
  directory: string;
  enabled: boolean;
  core?: boolean;
  isCustom?: boolean;
  resourceId?: string;
  scopeType?: 'system' | 'organization' | 'user';
  sourceType?: 'core' | 'standalone' | 'plugin';
  revision?: number;
  checksum?: string;
  readiness?: 'available' | 'disabled' | 'blocked' | 'conflict' | 'personal-connection-required';
  effectivePolicy?: 'optional' | 'default-enabled' | 'required' | 'blocked';
  blockedReason?: string | null;
  conflictResourceIds?: string[];
  interface?: CanvasSkillInterface;
  plugin?: {
    name: string;
    version: string;
    displayName?: string;
    skillAssetPath?: string;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface SkillFrontmatterValidationOptions {
  expectedDirectoryName?: string;
}

const AGENT_SKILL_FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
  'metadata',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeInterface(value: unknown): CanvasSkillInterface | undefined {
  if (!isRecord(value)) return undefined;

  const iface: CanvasSkillInterface = {
    displayName: stringValue(value.display_name ?? value.displayName),
    shortDescription: stringValue(value.short_description ?? value.shortDescription),
    iconSmall: stringValue(value.icon_small ?? value.iconSmall),
    iconLarge: stringValue(value.icon_large ?? value.iconLarge),
    brandColor: stringValue(value.brand_color ?? value.brandColor),
    defaultPrompt: stringValue(value.default_prompt ?? value.defaultPrompt),
    version: stringValue(value.version),
  };

  return Object.values(iface).some(Boolean) ? iface : undefined;
}

function canvasYamlVersion(value: Record<string, unknown>): string | undefined {
  const skill = isRecord(value.skill) ? value.skill : undefined;
  const packageMetadata = isRecord(value.package) ? value.package : undefined;
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const iface = isRecord(value.interface) ? value.interface : undefined;

  return stringValue(skill?.version)
    ?? stringValue(packageMetadata?.version)
    ?? stringValue(metadata?.version)
    ?? stringValue(value.version)
    ?? stringValue(iface?.version);
}

export function parseFrontmatter(content: string): {
  frontmatter: CanvasSkillFrontmatter | null;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }

  try {
    const parsed = YAML.parse(match[1]) as unknown;
    if (!isRecord(parsed)) {
      return { frontmatter: null, body: match[2].trim() };
    }

    return {
      // Parsing intentionally preserves raw values and unknown keys. Validation
      // must see the original YAML shape instead of a normalized subset.
      frontmatter: parsed as unknown as CanvasSkillFrontmatter,
      body: match[2].trim(),
    };
  } catch {
    return { frontmatter: null, body: match[2].trim() };
  }
}

export function extractTitle(skillName: string): string {
  return skillName
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeSkillName(value: string): string {
  return value.trim().normalize('NFKC');
}

function isAgentSkillNameCharacter(value: string): boolean {
  return value === '-' || /^[\p{L}\p{N}]$/u.test(value);
}

export function isValidAgentSkillName(value: string): boolean {
  const name = normalizeSkillName(value);
  return value === name
    && Array.from(name).length >= 1
    && Array.from(name).length <= 64
    && name === name.toLowerCase()
    && !name.startsWith('-')
    && !name.endsWith('-')
    && !name.includes('--')
    && Array.from(name).every(isAgentSkillNameCharacter);
}

function validatedFrontmatter(frontmatter: CanvasSkillFrontmatter): CanvasSkillFrontmatter {
  const raw = frontmatter as unknown as Record<string, unknown>;
  const metadata = isRecord(raw.metadata)
    ? Object.fromEntries(Object.entries(raw.metadata).map(([key, value]) => [key, value as string]))
    : undefined;

  return {
    name: normalizeSkillName(raw.name as string),
    description: (raw.description as string).trim(),
    license: typeof raw.license === 'string' ? raw.license.trim() : undefined,
    compatibility: typeof raw.compatibility === 'string' ? raw.compatibility.trim() : undefined,
    'allowed-tools': typeof raw['allowed-tools'] === 'string' ? raw['allowed-tools'].trim() : undefined,
    metadata,
  };
}

export function validateFrontmatter(
  frontmatter: CanvasSkillFrontmatter | null,
  options: SkillFrontmatterValidationOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!frontmatter) {
    errors.push('Missing YAML frontmatter');
    return { valid: false, errors, warnings };
  }

  const raw = frontmatter as unknown as Record<string, unknown>;
  const unexpectedFields = Object.keys(raw).filter((field) => !AGENT_SKILL_FRONTMATTER_FIELDS.has(field));
  if (unexpectedFields.length > 0) {
    errors.push(`Unexpected fields in frontmatter: ${unexpectedFields.sort().join(', ')}.`);
  }

  if (!Object.hasOwn(raw, 'name')) {
    errors.push('Missing required field: name');
  } else if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    errors.push('name: Must be a non-empty string.');
  } else {
    const name = normalizeSkillName(raw.name);
    const nameLength = Array.from(name).length;
    if (nameLength > 64) {
      errors.push(`name: Too long (${nameLength} chars). Maximum is 64 characters.`);
    }
    if (name !== name.toLowerCase()) {
      errors.push('name: Must be lowercase.');
    }
    if (name.startsWith('-') || name.endsWith('-')) {
      errors.push('name: Cannot start or end with a hyphen.');
    }
    if (name.includes('--')) {
      errors.push('name: Cannot contain consecutive hyphens.');
    }
    if (!Array.from(name).every(isAgentSkillNameCharacter)) {
      errors.push('name: Only letters, numbers, and hyphens are allowed.');
    }
    if (options.expectedDirectoryName) {
      const directoryName = options.expectedDirectoryName.normalize('NFKC');
      if (directoryName !== name) {
        errors.push(`Directory name "${options.expectedDirectoryName}" must match skill name "${name}".`);
      }
    }
  }

  if (!Object.hasOwn(raw, 'description')) {
    errors.push('Missing required field: description');
  } else if (typeof raw.description !== 'string' || raw.description.trim().length === 0) {
    errors.push('description: Must be a non-empty string.');
  } else {
    const descriptionLength = Array.from(raw.description).length;
    if (descriptionLength > 1024) {
      errors.push(`description: Too long (${descriptionLength} chars). Maximum is 1024 characters.`);
    }
  }

  if (raw.license !== undefined && typeof raw.license !== 'string') {
    errors.push('license: Must be a string if provided.');
  }

  if (raw.compatibility !== undefined) {
    if (typeof raw.compatibility !== 'string') {
      errors.push('compatibility: Must be a string if provided.');
    } else if (raw.compatibility.trim().length === 0) {
      errors.push('compatibility: Must not be empty if provided.');
    } else if (Array.from(raw.compatibility).length > 500) {
      errors.push(`compatibility: Too long (${Array.from(raw.compatibility).length} chars). Maximum is 500 characters.`);
    }
  }

  if (raw['allowed-tools'] !== undefined && typeof raw['allowed-tools'] !== 'string') {
    errors.push('allowed-tools: Must be a string if provided.');
  }

  if (raw.metadata !== undefined) {
    if (!isRecord(raw.metadata)) {
      errors.push('metadata: Must be a key-value mapping if provided.');
    } else {
      for (const [key, val] of Object.entries(raw.metadata)) {
        if (typeof val !== 'string') {
          errors.push(`metadata: Value for key "${key}" must be a string, got ${typeof val}.`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export async function loadCanvasSkillInterface(skillDir: string): Promise<CanvasSkillInterface | undefined> {
  const interfacePath = requirePathInside(skillDir, CANVAS_SKILL_INTERFACE_PATH);
  let raw: string;

  try {
    raw = await fs.readFile(interfacePath, 'utf-8');
  } catch {
    return undefined;
  }

  try {
    const parsed = YAML.parse(raw) as unknown;
    if (!isRecord(parsed)) return undefined;
    const iface = normalizeInterface(parsed.interface) ?? {};
    const version = canvasYamlVersion(parsed);
    if (version) {
      iface.version = version;
    }
    return Object.values(iface).some(Boolean) ? iface : undefined;
  } catch (error) {
    console.warn('[CanvasSkillParser] Invalid Canvas skill interface.', { path: interfacePath, error });
    return undefined;
  }
}

export async function parseSkillFile(
  skillPath: string,
  options: { validateDirectoryName?: boolean } = { validateDirectoryName: true },
): Promise<CanvasSkill | null> {
  try {
    const content = await fs.readFile(requirePathInside(path.dirname(skillPath), path.basename(skillPath)), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    const validation = validateFrontmatter(frontmatter, {
      expectedDirectoryName: options.validateDirectoryName !== false ? path.basename(path.dirname(skillPath)) : undefined,
    });

    if (!validation.valid || !frontmatter) {
      console.warn('[CanvasSkillParser] Invalid skill.', { path: skillPath, errors: validation.errors });
      return null;
    }

    const manifest = validatedFrontmatter(frontmatter);
    const skillName = manifest.name;
    const directory = path.dirname(skillPath);
    const iface = await loadCanvasSkillInterface(directory);
    const frontmatterVersion = manifest.metadata?.version;
    const canvasVersion = iface?.version;

    if (frontmatterVersion && canvasVersion && frontmatterVersion !== canvasVersion) {
      console.warn('[CanvasSkillParser] Skill version mismatch.', {
        path: skillPath,
        frontmatterVersion,
        canvasVersion,
      });
      return null;
    }

    return {
      name: skillName,
      description: manifest.description,
      license: manifest.license,
      compatibility: manifest.compatibility,
      version: frontmatterVersion || canvasVersion,
      title: iface?.displayName || extractTitle(skillName),
      content: body,
      path: skillPath,
      directory,
      enabled: true,
      isCustom: true,
      interface: iface,
    };
  } catch (error) {
    console.error('[CanvasSkillParser] Error parsing skill.', { path: skillPath, error });
    return null;
  }
}

export function createDefaultSkillMd(
  name: string,
  description: string,
  content: string = '',
): string {
  const title = extractTitle(name);
  return `---
name: ${name}
description: "${description}"
---

# ${title}

${content || 'Add your Canvas skill instructions here...'}
`;
}

export type CanvasSkillStorageScope = UserScopedDataStorageScope;

export function getSkillsDir(scope?: CanvasSkillStorageScope | null): string {
  return resolveScopedSkillsDataDir(scope);
}
