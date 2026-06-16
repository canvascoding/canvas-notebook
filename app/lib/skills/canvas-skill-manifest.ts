import { promises as fs } from 'fs';
import path from 'path';
import YAML from 'yaml';

import { resolveSkillsDataDir } from '@/app/lib/runtime-data-paths';

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
  isCustom?: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key, stringValue(entryValue)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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
  };

  return Object.values(iface).some(Boolean) ? iface : undefined;
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

    const frontmatter: Partial<CanvasSkillFrontmatter> = {
      name: stringValue(parsed.name) || '',
      description: stringValue(parsed.description) || '',
      license: stringValue(parsed.license),
      compatibility: stringValue(parsed.compatibility),
      'allowed-tools': stringValue(parsed['allowed-tools']),
      metadata: normalizeStringRecord(parsed.metadata),
    };

    return {
      frontmatter: frontmatter as CanvasSkillFrontmatter,
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

export function validateFrontmatter(frontmatter: CanvasSkillFrontmatter | null): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!frontmatter) {
    errors.push('Missing YAML frontmatter');
    return { valid: false, errors, warnings };
  }

  if (!frontmatter.name) {
    errors.push('Missing required field: name');
  } else {
    if (frontmatter.name.length > 64) {
      errors.push(`name: Too long (${frontmatter.name.length} chars). Maximum is 64 characters.`);
    }
    if (!/^[a-z0-9]+([a-z0-9-]*[a-z0-9]+)?$/.test(frontmatter.name)) {
      errors.push('name: Must be lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen or contain consecutive hyphens.');
    }
  }

  if (!frontmatter.description) {
    errors.push('Missing required field: description');
  } else {
    if (frontmatter.description.trim().length === 0) {
      errors.push('description: Must not be empty.');
    }
    if (frontmatter.description.length > 1024) {
      errors.push(`description: Too long (${frontmatter.description.length} chars). Maximum is 1024 characters.`);
    }
    if (/<|>/.test(frontmatter.description)) {
      errors.push('description: Cannot contain angle brackets (< or >).');
    }
  }

  if (frontmatter.license !== undefined && typeof frontmatter.license !== 'string') {
    errors.push('license: Must be a string if provided.');
  }

  if (frontmatter.compatibility !== undefined) {
    if (typeof frontmatter.compatibility !== 'string') {
      errors.push('compatibility: Must be a string if provided.');
    } else if (frontmatter.compatibility.length > 500) {
      errors.push(`compatibility: Too long (${frontmatter.compatibility.length} chars). Maximum is 500 characters.`);
    }
  }

  if (frontmatter['allowed-tools'] !== undefined && typeof frontmatter['allowed-tools'] !== 'string') {
    errors.push('allowed-tools: Must be a string if provided.');
  }

  if (frontmatter.metadata !== undefined) {
    if (!isRecord(frontmatter.metadata)) {
      errors.push('metadata: Must be a key-value mapping if provided.');
    } else {
      for (const [key, val] of Object.entries(frontmatter.metadata)) {
        if (typeof val !== 'string') {
          errors.push(`metadata: Value for key "${key}" must be a string, got ${typeof val}.`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export async function loadCanvasSkillInterface(skillDir: string): Promise<CanvasSkillInterface | undefined> {
  const interfacePath = path.join(skillDir, CANVAS_SKILL_INTERFACE_PATH);
  let raw: string;

  try {
    raw = await fs.readFile(interfacePath, 'utf-8');
  } catch {
    return undefined;
  }

  try {
    const parsed = YAML.parse(raw) as unknown;
    if (!isRecord(parsed)) return undefined;
    return normalizeInterface(parsed.interface);
  } catch (error) {
    console.warn(`[CanvasSkillParser] Invalid Canvas skill interface at ${interfacePath}:`, error);
    return undefined;
  }
}

export async function parseSkillFile(skillPath: string): Promise<CanvasSkill | null> {
  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    const validation = validateFrontmatter(frontmatter);

    if (!validation.valid) {
      console.warn(`[CanvasSkillParser] Invalid skill at ${skillPath}:`, validation.errors);
      return null;
    }

    const skillName = frontmatter!.name;
    const directory = path.dirname(skillPath);
    const iface = await loadCanvasSkillInterface(directory);

    return {
      name: skillName,
      description: frontmatter!.description,
      license: frontmatter!.license,
      compatibility: frontmatter!.compatibility,
      version: frontmatter!.metadata?.version,
      title: iface?.displayName || extractTitle(skillName),
      content: body,
      path: skillPath,
      directory,
      enabled: true,
      isCustom: true,
      interface: iface,
    };
  } catch (error) {
    console.error(`[CanvasSkillParser] Error parsing skill at ${skillPath}:`, error);
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

export function getSkillsDir(): string {
  return resolveSkillsDataDir();
}
