import { promises as fs } from 'fs';
import path from 'path';

export const CANVAS_PLUGIN_MANIFEST_PATH = path.join('.canvas-plugin', 'plugin.json');

export interface CanvasPluginAuthor {
  name?: string;
  url?: string;
}

export interface CanvasPluginInterface {
  displayName?: string;
  shortDescription?: string;
  category?: string;
  brandColor?: string;
  icon?: string;
  logo?: string;
  defaultPrompt?: string[];
}

export interface CanvasPluginConnectorManifest {
  composio?: CanvasPluginComposioConnector[];
  email?: CanvasPluginEmailConnector[];
  mcp?: CanvasPluginMcpConnector[];
  /**
   * @deprecated Use mcp[].configPath. Kept for older local plugin packages.
   */
  mcpServers?: string;
  /**
   * @deprecated Use composio[].toolkit. Kept for older local plugin packages.
   */
  composioToolkits?: string[];
}

export interface CanvasPluginComposioConnector {
  toolkit: string;
  label?: string;
  reason?: string;
  recommended?: boolean;
  required?: boolean;
  tools?: string[];
}

export interface CanvasPluginEmailConnector {
  kind?: 'mailbox';
  label?: string;
  reason?: string;
  recommended?: boolean;
  required?: boolean;
  providers?: Array<'gmail' | 'imap-smtp'>;
}

export interface CanvasPluginMcpConnector {
  name: string;
  label?: string;
  reason?: string;
  recommended?: boolean;
  required?: boolean;
  configPath?: string;
  env?: string[];
  oauth?: boolean;
}

export interface CanvasPluginManifest {
  name: string;
  version: string;
  description: string;
  license?: string;
  author?: CanvasPluginAuthor;
  source?: string;
  skills: string;
  interface?: CanvasPluginInterface;
  connectors?: CanvasPluginConnectorManifest;
}

export interface CanvasPluginValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: CanvasPluginManifest;
  rootDir?: string;
  manifestPath?: string;
  skillsDir?: string;
}

export function isValidCanvasPluginName(name: string): boolean {
  return /^[a-z0-9]+([a-z0-9-]*[a-z0-9]+)?$/.test(name);
}

export function isValidCanvasPluginVersion(version: string): boolean {
  return /^[0-9]+(?:\.[0-9]+){0,2}(?:[-+][a-z0-9.-]+)?$/i.test(version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => stringValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries : undefined;
  }

  const single = stringValue(value);
  return single ? [single] : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeAuthor(value: unknown): CanvasPluginAuthor | undefined {
  if (!isRecord(value)) return undefined;
  const author: CanvasPluginAuthor = {
    name: stringValue(value.name),
    url: stringValue(value.url),
  };
  return Object.values(author).some(Boolean) ? author : undefined;
}

function normalizeInterface(value: unknown): CanvasPluginInterface | undefined {
  if (!isRecord(value)) return undefined;

  const defaultPromptValue = value.default_prompt ?? value.defaultPrompt;
  const iface: CanvasPluginInterface = {
    displayName: stringValue(value.display_name ?? value.displayName),
    shortDescription: stringValue(value.short_description ?? value.shortDescription),
    category: stringValue(value.category),
    brandColor: stringValue(value.brand_color ?? value.brandColor),
    icon: stringValue(value.icon),
    logo: stringValue(value.logo),
    defaultPrompt: stringArrayValue(defaultPromptValue),
  };

  return Object.values(iface).some(Boolean) ? iface : undefined;
}

function normalizeComposioConnector(value: unknown): CanvasPluginComposioConnector | null {
  const legacyToolkit = stringValue(value);
  if (legacyToolkit) {
    return { toolkit: legacyToolkit, recommended: true };
  }

  if (!isRecord(value)) return null;
  const toolkit = stringValue(value.toolkit ?? value.slug ?? value.toolkitSlug);
  if (!toolkit) return null;

  return {
    toolkit,
    label: stringValue(value.label ?? value.name),
    reason: stringValue(value.reason),
    recommended: booleanValue(value.recommended),
    required: booleanValue(value.required),
    tools: stringArrayValue(value.tools),
  };
}

function normalizeComposioConnectors(value: unknown): CanvasPluginComposioConnector[] | undefined {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const connectors = entries
    .map(normalizeComposioConnector)
    .filter((connector): connector is CanvasPluginComposioConnector => Boolean(connector));
  return connectors.length > 0 ? connectors : undefined;
}

function normalizeEmailConnector(value: unknown): CanvasPluginEmailConnector | null {
  if (!isRecord(value)) return null;
  const providers = stringArrayValue(value.providers)
    ?.filter((provider): provider is 'gmail' | 'imap-smtp' => provider === 'gmail' || provider === 'imap-smtp');

  return {
    kind: stringValue(value.kind) === 'mailbox' ? 'mailbox' : undefined,
    label: stringValue(value.label ?? value.name),
    reason: stringValue(value.reason),
    recommended: booleanValue(value.recommended),
    required: booleanValue(value.required),
    providers,
  };
}

function normalizeEmailConnectors(value: unknown): CanvasPluginEmailConnector[] | undefined {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const connectors = entries
    .map(normalizeEmailConnector)
    .filter((connector): connector is CanvasPluginEmailConnector => Boolean(connector));
  return connectors.length > 0 ? connectors : undefined;
}

function normalizeMcpConnector(value: unknown): CanvasPluginMcpConnector | null {
  const legacyName = stringValue(value);
  if (legacyName) {
    return { name: legacyName, label: legacyName, recommended: true };
  }

  if (!isRecord(value)) return null;
  const name = stringValue(value.name ?? value.id);
  if (!name) return null;

  return {
    name,
    label: stringValue(value.label),
    reason: stringValue(value.reason),
    recommended: booleanValue(value.recommended),
    required: booleanValue(value.required),
    configPath: stringValue(value.configPath ?? value.config_path),
    env: stringArrayValue(value.env),
    oauth: booleanValue(value.oauth),
  };
}

function normalizeMcpConnectors(value: unknown): CanvasPluginMcpConnector[] | undefined {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const connectors = entries
    .map(normalizeMcpConnector)
    .filter((connector): connector is CanvasPluginMcpConnector => Boolean(connector));
  return connectors.length > 0 ? connectors : undefined;
}

function normalizeConnectors(parsed: Record<string, unknown>): CanvasPluginConnectorManifest | undefined {
  const connectors = isRecord(parsed.connectors) ? parsed.connectors : {};
  const mcpServers = stringValue(
    connectors.mcp_servers
      ?? connectors.mcpServers
      ?? parsed.mcp_servers
      ?? parsed.mcpServers,
  );
  const composioToolkits = stringArrayValue(
    connectors.composio_toolkits
      ?? connectors.composioToolkits
      ?? connectors.composio
      ?? parsed.composio_toolkits
      ?? parsed.composioToolkits
      ?? parsed.composio,
  );
  const composio = normalizeComposioConnectors(
    connectors.composio
      ?? connectors.composio_recommendations
      ?? connectors.composioRecommendations
      ?? composioToolkits,
  );
  const email = normalizeEmailConnectors(
    connectors.email
      ?? connectors.email_recommendations
      ?? connectors.emailRecommendations,
  );
  const mcp = normalizeMcpConnectors(
    connectors.mcp
      ?? connectors.mcp_recommendations
      ?? connectors.mcpRecommendations,
  );

  const result: CanvasPluginConnectorManifest = {
    composio,
    email,
    mcp,
    mcpServers,
    composioToolkits,
  };
  return Object.values(result).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)) ? result : undefined;
}

function normalizeManifest(parsed: unknown): CanvasPluginManifest | null {
  if (!isRecord(parsed)) return null;

  const manifest: CanvasPluginManifest = {
    name: stringValue(parsed.name) || '',
    version: stringValue(parsed.version) || '',
    description: stringValue(parsed.description) || '',
    license: stringValue(parsed.license),
    author: normalizeAuthor(parsed.author),
    source: stringValue(parsed.source),
    skills: stringValue(parsed.skills) || './skills',
    interface: normalizeInterface(parsed.interface),
    connectors: normalizeConnectors(parsed),
  };

  return manifest;
}

export function resolvePluginManifestPath(pluginRoot: string): string {
  return path.join(pluginRoot, CANVAS_PLUGIN_MANIFEST_PATH);
}

export function resolvePluginRelativePath(pluginRoot: string, relativePath: string): string {
  return path.resolve(/*turbopackIgnore: true*/ pluginRoot, relativePath);
}

export function isPathInside(parentDir: string, childPath: string): boolean {
  const resolvedParent = path.resolve(/*turbopackIgnore: true*/ parentDir);
  const resolvedChild = path.resolve(/*turbopackIgnore: true*/ childPath);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

function validateRelativePath(
  label: string,
  pluginRoot: string,
  relativePath: string | undefined,
  errors: string[],
): string | undefined {
  if (!relativePath) return undefined;
  if (path.isAbsolute(relativePath)) {
    errors.push(`${label}: Must be a relative path inside the plugin package.`);
    return undefined;
  }

  const resolvedPath = resolvePluginRelativePath(pluginRoot, relativePath);
  if (!isPathInside(pluginRoot, resolvedPath)) {
    errors.push(`${label}: Path must stay inside the plugin package.`);
    return undefined;
  }
  return resolvedPath;
}

export async function validateCanvasPluginPackage(sourcePath: string): Promise<CanvasPluginValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rootDir = path.resolve(/*turbopackIgnore: true*/ sourcePath);
  const manifestPath = resolvePluginManifestPath(rootDir);

  let rawManifest: string;
  try {
    const stat = await fs.stat(rootDir);
    if (!stat.isDirectory()) {
      return {
        valid: false,
        errors: ['Plugin source path must be a directory.'],
        warnings,
        rootDir,
        manifestPath,
      };
    }
    rawManifest = await fs.readFile(manifestPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      valid: false,
      errors: [code === 'ENOENT' ? `Missing ${CANVAS_PLUGIN_MANIFEST_PATH}` : 'Failed to read plugin manifest.'],
      warnings,
      rootDir,
      manifestPath,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest) as unknown;
  } catch {
    return {
      valid: false,
      errors: ['Plugin manifest must be valid JSON.'],
      warnings,
      rootDir,
      manifestPath,
    };
  }

  const manifest = normalizeManifest(parsed);
  if (!manifest) {
    errors.push('Plugin manifest must be a JSON object.');
  }

  if (manifest) {
    if (!manifest.name) {
      errors.push('name: Missing required field.');
    } else if (!isValidCanvasPluginName(manifest.name)) {
      errors.push('name: Must be lowercase letters, numbers, and hyphens only.');
    }

    if (!manifest.version) {
      errors.push('version: Missing required field.');
    } else if (!isValidCanvasPluginVersion(manifest.version)) {
      errors.push('version: Use a semantic version such as 1.0.0.');
    }

    if (!manifest.description) {
      errors.push('description: Missing required field.');
    } else if (manifest.description.length > 1024) {
      errors.push('description: Maximum length is 1024 characters.');
    }

    const skillsDir = validateRelativePath('skills', rootDir, manifest.skills, errors);
    if (skillsDir) {
      try {
        const stat = await fs.stat(skillsDir);
        if (!stat.isDirectory()) {
          errors.push('skills: Must point to a directory.');
        }
      } catch {
        errors.push('skills: Directory does not exist.');
      }
    }

    const legacyMcpPath = validateRelativePath('connectors.mcpServers', rootDir, manifest.connectors?.mcpServers, errors);
    if (legacyMcpPath) {
      try {
        const stat = await fs.stat(legacyMcpPath);
        if (!stat.isFile()) {
          errors.push('connectors.mcpServers: Must point to a file.');
        }
      } catch {
        warnings.push('connectors.mcpServers: File does not exist yet.');
      }
    }

    for (const [index, connector] of (manifest.connectors?.mcp || []).entries()) {
      if (!connector.configPath) continue;
      const mcpPath = validateRelativePath(`connectors.mcp[${index}].configPath`, rootDir, connector.configPath, errors);
      if (!mcpPath) continue;
      try {
        const stat = await fs.stat(mcpPath);
        if (!stat.isFile()) {
          errors.push(`connectors.mcp[${index}].configPath: Must point to a file.`);
        }
      } catch {
        errors.push(`connectors.mcp[${index}].configPath: File does not exist.`);
      }
    }

    validateRelativePath('interface.icon', rootDir, manifest.interface?.icon, errors);
    validateRelativePath('interface.logo', rootDir, manifest.interface?.logo, errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest: manifest || undefined,
    rootDir,
    manifestPath,
    skillsDir: manifest ? resolvePluginRelativePath(rootDir, manifest.skills) : undefined,
  };
}
