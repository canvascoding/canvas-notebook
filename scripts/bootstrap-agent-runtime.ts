import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadAppEnv } from '../server/load-app-env';
import { isOnboardingComplete } from '../app/lib/onboarding/status';
import { parseBootstrapSeedSkillNames } from '../app/lib/skills/default-seed-skills';
import { parseBootstrapSeedPluginNames } from '../app/lib/plugins/default-seed-plugins';

// Database imports are optional - they may not be available in Docker container
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let openDb: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aiMessages: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aiSessions: any;

// Inline runtime-data-paths functions (container-safe, no external deps)
const CONTAINER_DATA_ROOT = '/data';

function directoryExists(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveCanvasDataRoot(cwd = process.cwd()): string {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  if (directoryExists(CONTAINER_DATA_ROOT)) {
    return CONTAINER_DATA_ROOT;
  }
  return path.resolve(/*turbopackIgnore: true*/ cwd, 'data');
}

function resolveAgentStorageDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'canvas-agent');
}

function resolveSettingsStorageDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'settings');
}

function resolveAgentsStorageRoot(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'agents');
}

function resolveSecretsDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'secrets');
}

function resolveDefaultIntegrationsEnvPath(cwd = process.cwd()): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Integrations.env');
}

function resolveDefaultAgentsEnvPath(cwd = process.cwd()): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Agents.env');
}

loadAppEnv(process.cwd());

const AGENT_STORAGE_DIR = resolveAgentStorageDir();
const SETTINGS_STORAGE_DIR = resolveSettingsStorageDir();
const AGENTS_STORAGE_ROOT = resolveAgentsStorageRoot();
const CANVAS_AGENT_STORAGE_DIR = path.join(AGENTS_STORAGE_ROOT, 'canvas-agent');
const SECRETS_DIR = resolveSecretsDir();
const DEFAULT_INTEGRATIONS_ENV_PATH = resolveDefaultIntegrationsEnvPath();
const DEFAULT_AGENTS_ENV_PATH = resolveDefaultAgentsEnvPath();
const LEGACY_WIPE_MARKER_PATH = path.join(AGENT_STORAGE_DIR, '.legacy-session-wipe-done');
const WIPE_MARKER_PATH = path.join(SETTINGS_STORAGE_DIR, '.legacy-session-wipe-done');
const RUNTIME_CONFIG_PATH = path.join(SETTINGS_STORAGE_DIR, 'agent-runtime-config.json');

// Legacy paths for migration
const LEGACY_AGENT_STORAGE_DIR = '/home/node/canvas-agent';
const LEGACY_INTEGRATIONS_ENV_PATH = '/home/node/Canvas-Integrations.env';
const LEGACY_AGENTS_ENV_PATH = '/home/node/Canvas-Agents.env';

// Seed system prompts directory (relative to project root)
const SEED_SYS_PROMPTS_DIR = path.join(process.cwd(), 'seed_sys_prompts');
const SEED_SKILLS_DIR = path.join(process.cwd(), 'seed_skills');
const SEED_PLUGINS_DIR = path.join(process.cwd(), 'seed_plugins');
const SKILLS_STORAGE_DIR = path.join(resolveCanvasDataRoot(), 'skills');
const PLUGINS_STORAGE_DIR = path.join(resolveCanvasDataRoot(), 'plugins');
const INSTALLED_PLUGINS_DIR = path.join(PLUGINS_STORAGE_DIR, 'installed');
const PLUGIN_REGISTRY_PATH = path.join(PLUGINS_STORAGE_DIR, 'registry.json');
const SKILL_REGISTRY_PATH = path.join(SKILLS_STORAGE_DIR, 'registry.json');
const PI_RUNTIME_CONFIG_PATH = path.join(SETTINGS_STORAGE_DIR, 'pi-runtime-config.json');

// All managed files (excluding BOOTSTRAP.md which is only for initial setup)
const MANAGED_FILE_NAMES = ['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;
const GLOBAL_SETTINGS_FILE_NAMES = [
  'agent-runtime-config.json',
  'pi-runtime-config.json',
  'mcp.json',
  'mcp-cache.json',
  'mcp-server-icons.json',
  'auth.json',
] as const;
const GLOBAL_SETTINGS_DIR_NAMES = ['mcp-oauth', 'mcp-icons', 'email-oauth'] as const;

// Helper to read seed file content
async function readSeedFile(fileName: string): Promise<string | null> {
  const seedPath = path.join(SEED_SYS_PROMPTS_DIR, fileName);
  try {
    return await fs.readFile(seedPath, 'utf8');
  } catch {
    console.warn(`[bootstrap-agent-runtime] Seed file not found: ${seedPath}`);
    return null;
  }
}

// Check if content is effectively empty
function isContentEmpty(content: string | null): boolean {
  if (content === null) return true;
  return content.trim().length === 0;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function copyManagedFilesIfTargetMissing(sourceDir: string, label: string): Promise<void> {
  if (!(await fileExists(sourceDir))) {
    return;
  }

  console.log(`[bootstrap-agent-runtime] Checking for managed files in ${label}: ${sourceDir}...`);
  await fs.mkdir(CANVAS_AGENT_STORAGE_DIR, { recursive: true });

  for (const fileName of MANAGED_FILE_NAMES) {
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(CANVAS_AGENT_STORAGE_DIR, fileName);

    if (!(await fileExists(sourcePath))) {
      continue;
    }

    if (await fileExists(targetPath)) {
      continue;
    }

    console.log(`[bootstrap-agent-runtime] Migrating ${fileName} from ${label}...`);
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, 0o600);
  }
}

async function copyGlobalSettingsIfTargetMissing(sourceDir: string, label: string): Promise<void> {
  if (!(await fileExists(sourceDir))) {
    return;
  }

  console.log(`[bootstrap-agent-runtime] Checking for global settings in ${label}: ${sourceDir}...`);
  await fs.mkdir(SETTINGS_STORAGE_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(SETTINGS_STORAGE_DIR, 0o700).catch(() => undefined);

  for (const fileName of GLOBAL_SETTINGS_FILE_NAMES) {
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(SETTINGS_STORAGE_DIR, fileName);
    if (!(await fileExists(sourcePath)) || await fileExists(targetPath)) {
      continue;
    }

    console.log(`[bootstrap-agent-runtime] Migrating ${fileName} from ${label} to /data/settings...`);
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, 0o600).catch(() => undefined);
  }

  for (const dirName of GLOBAL_SETTINGS_DIR_NAMES) {
    const sourcePath = path.join(sourceDir, dirName);
    const targetPath = path.join(SETTINGS_STORAGE_DIR, dirName);
    if (!(await fileExists(sourcePath)) || await fileExists(targetPath)) {
      continue;
    }

    console.log(`[bootstrap-agent-runtime] Migrating ${dirName}/ from ${label} to /data/settings...`);
    await fs.cp(sourcePath, targetPath, { recursive: true, preserveTimestamps: true });
    await fs.chmod(targetPath, 0o700).catch(() => undefined);
  }
}

function getIntegrationsEnvPath(): string {
  const configured = process.env.INTEGRATIONS_ENV_PATH?.trim();
  return configured || DEFAULT_INTEGRATIONS_ENV_PATH;
}

function getAgentsEnvPath(): string {
  const configured = process.env.AGENTS_ENV_PATH?.trim();
  return configured || DEFAULT_AGENTS_ENV_PATH;
}

async function migrateLegacyFiles(): Promise<void> {
  // Migrate managed markdown files into the canonical /data/agents/canvas-agent directory.
  await copyManagedFilesIfTargetMissing(LEGACY_AGENT_STORAGE_DIR, 'legacy /home/node/canvas-agent');
  await copyManagedFilesIfTargetMissing(AGENT_STORAGE_DIR, 'legacy /data/canvas-agent');

  // Migrate global runtime and integration settings into /data/settings.
  await copyGlobalSettingsIfTargetMissing(LEGACY_AGENT_STORAGE_DIR, 'legacy /home/node/canvas-agent');
  await copyGlobalSettingsIfTargetMissing(AGENT_STORAGE_DIR, 'legacy /data/canvas-agent');
  
  // Migrate legacy env files
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  
  const migrations = [
    { legacy: LEGACY_INTEGRATIONS_ENV_PATH, current: getIntegrationsEnvPath(), label: 'Canvas-Integrations.env' },
    { legacy: LEGACY_AGENTS_ENV_PATH, current: getAgentsEnvPath(), label: 'Canvas-Agents.env' },
  ];
  
  for (const { legacy, current, label } of migrations) {
    if (await fileExists(legacy) && !(await fileExists(current))) {
      console.log(`[bootstrap-agent-runtime] Migrating ${label} from legacy location...`);
      await fs.copyFile(legacy, current);
      await fs.chmod(current, 0o600);
    }
  }
}

async function ensureIntegrationsEnvBootstrap(): Promise<void> {
  // Ensure secrets directory exists
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  
  const envFiles = [
    { label: 'integrations', filePath: getIntegrationsEnvPath() },
    { label: 'agents', filePath: getAgentsEnvPath() },
  ];

  for (const envFile of envFiles) {
    await fs.mkdir(path.dirname(envFile.filePath), { recursive: true });

    try {
      const handle = await fs.open(envFile.filePath, 'wx', 0o600);
      await handle.close();
      await fs.chmod(envFile.filePath, 0o600);
      console.log(`[bootstrap-agent-runtime] Created ${envFile.label} env file: ${envFile.filePath}.`);
      continue;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'EEXIST') {
          await fs.chmod(envFile.filePath, 0o600).catch(() => undefined);
          console.log(`[bootstrap-agent-runtime] ${envFile.label} env file exists: ${envFile.filePath} (preserved).`);
          continue;
        }

        if (error.code === 'EISDIR') {
          console.warn(`[bootstrap-agent-runtime] WARNING: ${envFile.label} env path is a directory: ${envFile.filePath}.`);
          continue;
        }
      }

      throw error;
    }
  }
}

function buildDefaultConfig() {
  return {
    version: 1,
    mainAgent: 'canvas-main-agent',
    provider: {
      id: 'codex-cli',
      kind: 'cli',
    },
    providers: {
      'codex-cli': {
        enabled: true,
        command: 'codex',
      },
      'claude-cli': {
        enabled: true,
        command: 'claude',
      },
      openrouter: {
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4.5',
        apiKeySource: 'agents-env',
      },
      ollama: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3.2:3b',
        apiKeySource: 'agents-env',
      },
    },
    doctor: {
      enableLivePing: true,
      timeoutMs: 2500,
    },
    updatedAt: new Date().toISOString(),
    updatedBy: 'system:bootstrap',
  };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(payload, null, 2));
}

async function ensureAgentStorageBootstrap(): Promise<void> {
  await fs.mkdir(SETTINGS_STORAGE_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(SETTINGS_STORAGE_DIR, 0o700).catch(() => undefined);
  await fs.mkdir(CANVAS_AGENT_STORAGE_DIR, { recursive: true });

  // Check onboarding status for BOOTSTRAP.md handling
  const onboardingComplete = await isOnboardingComplete().catch(() => false);

  for (const fileName of MANAGED_FILE_NAMES) {
    const targetPath = path.join(CANVAS_AGENT_STORAGE_DIR, fileName);

    // A present empty file is intentional, for example after resetting USER.md or MEMORY.md.
    if (await fileExists(targetPath)) {
      continue;
    }

    // Read seed content
    const seedContent = await readSeedFile(fileName);
    if (seedContent === null) {
      console.warn(`[bootstrap-agent-runtime] Seed content not found for ${fileName}, skipping.`);
      continue;
    }

    await writeTextAtomic(targetPath, seedContent);
    console.log(`[bootstrap-agent-runtime] Created ${fileName} with seed content.`);
  }

  // Handle BOOTSTRAP.md separately - only copy if onboarding not complete
  if (!onboardingComplete) {
    const bootstrapTargetPath = path.join(CANVAS_AGENT_STORAGE_DIR, 'BOOTSTRAP.md');
    const existingBootstrap = await readFileIfExists(bootstrapTargetPath);

    if (isContentEmpty(existingBootstrap)) {
      const bootstrapSeed = await readSeedFile('BOOTSTRAP.md');
      if (bootstrapSeed !== null) {
        await writeTextAtomic(bootstrapTargetPath, bootstrapSeed);
        console.log(`[bootstrap-agent-runtime] Created BOOTSTRAP.md with seed content.`);
      }
    }
  } else {
    console.log(`[bootstrap-agent-runtime] Skipping BOOTSTRAP.md (onboarding completed).`);
  }

  if (!(await fileExists(RUNTIME_CONFIG_PATH))) {
    await writeJsonAtomic(RUNTIME_CONFIG_PATH, buildDefaultConfig());
    console.log(`[bootstrap-agent-runtime] Created default runtime config.`);
  }
}

async function getInstalledPluginSkillNames(): Promise<Set<string>> {
  const names = new Set<string>();

  try {
    const parsed = JSON.parse(await fs.readFile(PLUGIN_REGISTRY_PATH, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.plugins)) {
      return names;
    }

    for (const plugin of Object.values(parsed.plugins)) {
      if (!isRecord(plugin) || !Array.isArray(plugin.skills)) {
        continue;
      }

      for (const skill of plugin.skills) {
        if (isRecord(skill)) {
          const name = stringValue(skill.name);
          if (name) {
            names.add(name);
          }
        }
      }
    }
  } catch {
    // No plugin registry yet.
  }

  return names;
}

async function ensureSeedSkillsBootstrap(): Promise<void> {
  if (!(await fileExists(SEED_SKILLS_DIR))) {
    console.log(`[bootstrap-agent-runtime] Seed skills directory not found: ${SEED_SKILLS_DIR}.`);
    return;
  }

  await fs.mkdir(SKILLS_STORAGE_DIR, { recursive: true });
  const bootstrapSeedSkillNames = parseBootstrapSeedSkillNames(process.env.CANVAS_BOOTSTRAP_SEED_SKILLS);
  const pluginProvidedSkillNames = await getInstalledPluginSkillNames();
  const entries = await fs.readdir(SEED_SKILLS_DIR, { withFileTypes: true });
  let copiedCount = 0;
  let skippedNonDefaultCount = 0;
  let skippedPluginProvidedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    if (!bootstrapSeedSkillNames.has(entry.name)) {
      skippedNonDefaultCount += 1;
      continue;
    }

    if (pluginProvidedSkillNames.has(entry.name)) {
      skippedPluginProvidedCount += 1;
      continue;
    }

    const sourcePath = path.join(SEED_SKILLS_DIR, entry.name);
    const targetPath = path.join(SKILLS_STORAGE_DIR, entry.name);
    const sourceSkillPath = path.join(sourcePath, 'SKILL.md');

    if (!(await fileExists(sourceSkillPath)) || await fileExists(targetPath)) {
      continue;
    }

    await fs.cp(sourcePath, targetPath, { recursive: true, preserveTimestamps: true });
    copiedCount += 1;
    console.log(`[bootstrap-agent-runtime] Installed seed skill ${entry.name}.`);
  }

  if (copiedCount === 0) {
    console.log('[bootstrap-agent-runtime] Seed skills already present or no valid seed skills found.');
  } else {
    console.log(`[bootstrap-agent-runtime] Installed ${copiedCount} seed skills.`);
  }
  if (skippedNonDefaultCount > 0) {
    console.log(`[bootstrap-agent-runtime] Skipped ${skippedNonDefaultCount} non-default seed skills.`);
  }
  if (skippedPluginProvidedCount > 0) {
    console.log(`[bootstrap-agent-runtime] Skipped ${skippedPluginProvidedCount} seed skills already provided by installed plugins.`);
  }
}

type SeedPluginManifest = {
  name: string;
  version: string;
  description: string;
  license?: string;
  author?: unknown;
  source?: string;
  skills?: string;
  interface?: unknown;
  connectors?: unknown;
};

type SeedPluginSkillRecord = {
  name: string;
  title: string;
  description: string;
  version?: string;
  path: string;
  directory: string;
  materialized?: boolean;
  preexistingStandalone?: boolean;
  standaloneDir?: string;
};

type SeedPluginRegistry = {
  version: 1;
  updatedAt: string;
  plugins: Record<string, unknown>;
};

type SeedSkillRegistry = {
  version: 1;
  updatedAt: string;
  skills: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isValidCanvasPackageName(name: string): boolean {
  return /^[a-z0-9]+([a-z0-9-]*[a-z0-9]+)?$/.test(name);
}

function isValidCanvasVersion(version: string): boolean {
  return /^[0-9]+(?:\.[0-9]+){0,2}(?:[-+][a-z0-9.-]+)?$/i.test(version);
}

function parseSimpleSkillFrontmatter(content: string): { name?: string; description?: string; license?: string; version?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const frontmatter = match[1];
  const readField = (fieldName: string) => {
    const fieldMatch = frontmatter.match(new RegExp(`^${fieldName}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
    return fieldMatch?.[1]?.trim();
  };
  const metadataVersionMatch = frontmatter.match(/^\s+version:\s*["']?([^"'\n]+)["']?\s*$/m);
  return {
    name: readField('name'),
    description: readField('description'),
    license: readField('license'),
    version: metadataVersionMatch?.[1]?.trim(),
  };
}

async function listFilesForChecksum(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (['.git', 'node_modules', '.DS_Store'].includes(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesForChecksum(rootDir, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function computeSeedPluginChecksum(rootDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = await listFilesForChecksum(rootDir);
  for (const relativeFile of files) {
    hash.update(relativeFile);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(rootDir, relativeFile)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readSeedPluginRegistry(): Promise<SeedPluginRegistry> {
  try {
    const raw = await fs.readFile(PLUGIN_REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SeedPluginRegistry;
    if (parsed?.version === 1 && isRecord(parsed.plugins)) {
      return parsed;
    }
  } catch {
    // Missing or invalid registry is recreated below.
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    plugins: {},
  };
}

async function readSeedSkillRegistry(): Promise<SeedSkillRegistry> {
  try {
    const raw = await fs.readFile(SKILL_REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SeedSkillRegistry;
    if (parsed?.version === 1 && isRecord(parsed.skills)) {
      return parsed;
    }
  } catch {
    // Missing or invalid registry is recreated below.
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: {},
  };
}

async function readSeedPluginManifest(pluginRoot: string): Promise<SeedPluginManifest | null> {
  const manifestPath = path.join(pluginRoot, '.canvas-plugin', 'plugin.json');
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) return null;
    const manifest: SeedPluginManifest = {
      name: stringValue(parsed.name) || '',
      version: stringValue(parsed.version) || '',
      description: stringValue(parsed.description) || '',
      license: stringValue(parsed.license),
      author: parsed.author,
      source: stringValue(parsed.source),
      skills: stringValue(parsed.skills) || './skills',
      interface: parsed.interface,
      connectors: parsed.connectors,
    };
    if (!isValidCanvasPackageName(manifest.name) || !isValidCanvasVersion(manifest.version) || !manifest.description) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

async function discoverSeedPluginSkills(pluginRoot: string, manifest: SeedPluginManifest): Promise<SeedPluginSkillRecord[]> {
  const skillsDir = path.resolve(pluginRoot, manifest.skills || './skills');
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const records: SeedPluginSkillRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillDir = path.join(skillsDir, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const stat = await fs.stat(skillPath).catch(() => null);
    if (!stat?.isFile()) continue;

    const skillFrontmatter = parseSimpleSkillFrontmatter(await fs.readFile(skillPath, 'utf8'));
    const skillName = skillFrontmatter.name || entry.name;
    if (!isValidCanvasPackageName(skillName)) continue;

    records.push({
      name: skillName,
      title: skillName
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' '),
      description: skillFrontmatter.description || '',
      version: skillFrontmatter.version,
      path: path.join(INSTALLED_PLUGINS_DIR, manifest.name, manifest.version, path.relative(pluginRoot, skillPath)),
      directory: path.join(INSTALLED_PLUGINS_DIR, manifest.name, manifest.version, path.relative(pluginRoot, skillDir)),
    });
  }

  return records.sort((left, right) => left.name.localeCompare(right.name));
}

async function materializeSeedPluginSkills(
  manifest: SeedPluginManifest,
  skills: SeedPluginSkillRecord[],
): Promise<SeedPluginSkillRecord[]> {
  const registry = await readSeedSkillRegistry();
  const updatedSkills: SeedPluginSkillRecord[] = [];
  let registryChanged = false;

  await fs.mkdir(SKILLS_STORAGE_DIR, { recursive: true });

  for (const skill of skills) {
    const standaloneDir = path.join(SKILLS_STORAGE_DIR, skill.name);
    const standaloneSkillPath = path.join(standaloneDir, 'SKILL.md');
    if (await fileExists(standaloneSkillPath)) {
      updatedSkills.push({
        ...skill,
        materialized: false,
        preexistingStandalone: true,
        standaloneDir,
      });
      continue;
    }

    if (await fileExists(standaloneDir)) {
      console.warn(`[bootstrap-agent-runtime] Skill target exists but is not a valid skill, skipping materialization: ${standaloneDir}`);
      updatedSkills.push({
        ...skill,
        materialized: false,
        preexistingStandalone: true,
        standaloneDir,
      });
      continue;
    }

    await fs.cp(skill.directory, standaloneDir, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => !['.git', 'node_modules', '.DS_Store'].includes(path.basename(source)),
    });
    const skillFrontmatter = parseSimpleSkillFrontmatter(await fs.readFile(standaloneSkillPath, 'utf8'));
    const timestamp = new Date().toISOString();
    const existing = isRecord(registry.skills[skill.name])
      ? registry.skills[skill.name] as Record<string, unknown>
      : undefined;
    registry.skills[skill.name] = {
      name: skill.name,
      version: skillFrontmatter.version || skill.version || manifest.version,
      description: skillFrontmatter.description || skill.description,
      license: skillFrontmatter.license,
      sourceType: 'plugin',
      sourcePath: skill.directory,
      sourcePluginName: manifest.name,
      sourcePluginVersion: manifest.version,
      installedAt: stringValue(existing?.installedAt) || timestamp,
      updatedAt: timestamp,
      checksum: await computeSeedPluginChecksum(standaloneDir),
      installDir: standaloneDir,
      skillPath: standaloneSkillPath,
    };
    registryChanged = true;
    updatedSkills.push({
      ...skill,
      materialized: true,
      preexistingStandalone: false,
      standaloneDir,
    });
  }

  if (registryChanged) {
    await fs.mkdir(SKILLS_STORAGE_DIR, { recursive: true });
    await writeJsonAtomic(SKILL_REGISTRY_PATH, {
      ...registry,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
  }

  return updatedSkills;
}

function getSeedPluginInstallEnabledSkillNames(skills: SeedPluginSkillRecord[]): string[] {
  return skills
    .filter((skill) => skill.materialized || (!skill.materialized && !skill.preexistingStandalone))
    .map((skill) => skill.name);
}

async function enableSeedPluginSkillsInPiConfig(skillNames: string[]): Promise<void> {
  if (!(await fileExists(PI_RUNTIME_CONFIG_PATH))) return;

  try {
    const config = JSON.parse(await fs.readFile(PI_RUNTIME_CONFIG_PATH, 'utf8')) as { enabledSkills?: unknown; updatedAt?: string };
    if (!Array.isArray(config.enabledSkills) || config.enabledSkills.length === 0) {
      return;
    }

    const nextEnabled = new Set(
      config.enabledSkills
        .filter((entry): entry is string => typeof entry === 'string' && entry !== '__none__'),
    );
    for (const skillName of skillNames) {
      nextEnabled.add(skillName);
    }
    config.enabledSkills = [...nextEnabled].sort((left, right) => left.localeCompare(right));
    config.updatedAt = new Date().toISOString();
    await writeJsonAtomic(PI_RUNTIME_CONFIG_PATH, config);
  } catch (error) {
    console.warn('[bootstrap-agent-runtime] Failed to update PI runtime config for seed plugin skills:', error);
  }
}

async function ensureSeedPluginsBootstrap(): Promise<void> {
  if (!(await fileExists(SEED_PLUGINS_DIR))) {
    console.log(`[bootstrap-agent-runtime] Seed plugins directory not found: ${SEED_PLUGINS_DIR}.`);
    return;
  }

  await fs.mkdir(INSTALLED_PLUGINS_DIR, { recursive: true });
  const bootstrapSeedPluginNames = parseBootstrapSeedPluginNames(process.env.CANVAS_BOOTSTRAP_SEED_PLUGINS);
  const entries = await fs.readdir(SEED_PLUGINS_DIR, { withFileTypes: true });
  const registry = await readSeedPluginRegistry();
  let installedCount = 0;
  let skippedNonDefaultCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!bootstrapSeedPluginNames.has(entry.name)) {
      skippedNonDefaultCount += 1;
      continue;
    }

    const sourcePath = path.join(SEED_PLUGINS_DIR, entry.name);
    const manifest = await readSeedPluginManifest(sourcePath);
    if (!manifest) {
      console.warn(`[bootstrap-agent-runtime] Invalid seed plugin skipped: ${entry.name}.`);
      continue;
    }
    if (registry.plugins[manifest.name]) {
      continue;
    }

    const skills = await discoverSeedPluginSkills(sourcePath, manifest);
    if (skills.length === 0) {
      console.warn(`[bootstrap-agent-runtime] Seed plugin ${manifest.name} has no valid skills.`);
      continue;
    }

    const installDir = path.join(INSTALLED_PLUGINS_DIR, manifest.name, manifest.version);
    await fs.rm(installDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(installDir), { recursive: true });
    await fs.cp(sourcePath, installDir, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => !['.git', 'node_modules', '.DS_Store'].includes(path.basename(source)),
    });

    const installedSkillsDir = path.join(installDir, manifest.skills || './skills');
    const materializedSkills = await materializeSeedPluginSkills(manifest, skills);
    const checksum = await computeSeedPluginChecksum(installDir);
    const timestamp = new Date().toISOString();
    registry.plugins[manifest.name] = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      license: manifest.license,
      author: manifest.author,
      source: manifest.source || 'seed',
      sourcePath,
      installedAt: timestamp,
      updatedAt: timestamp,
      enabled: true,
      checksum,
      installDir,
      manifestPath: path.join(installDir, '.canvas-plugin', 'plugin.json'),
      skillsDir: installedSkillsDir,
      skills: materializedSkills,
      interface: manifest.interface,
      connectors: manifest.connectors,
    };
    await enableSeedPluginSkillsInPiConfig(getSeedPluginInstallEnabledSkillNames(materializedSkills));
    installedCount += 1;
    console.log(`[bootstrap-agent-runtime] Installed seed plugin ${manifest.name}.`);
  }

  if (installedCount > 0) {
    await fs.mkdir(PLUGINS_STORAGE_DIR, { recursive: true });
    await writeJsonAtomic(PLUGIN_REGISTRY_PATH, {
      ...registry,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    console.log(`[bootstrap-agent-runtime] Installed ${installedCount} seed plugins.`);
  } else {
    console.log('[bootstrap-agent-runtime] Seed plugins already present or no valid seed plugins found.');
  }
  if (skippedNonDefaultCount > 0) {
    console.log(`[bootstrap-agent-runtime] Skipped ${skippedNonDefaultCount} non-default seed plugins.`);
  }
}

async function runLegacySessionCleanupIfNeeded(): Promise<void> {
  if (await fileExists(WIPE_MARKER_PATH)) {
    console.log(`[bootstrap-agent-runtime] Legacy wipe skipped (marker exists: ${WIPE_MARKER_PATH}).`);
    return;
  }

  if (await fileExists(LEGACY_WIPE_MARKER_PATH)) {
    await fs.mkdir(SETTINGS_STORAGE_DIR, { recursive: true, mode: 0o700 }).catch(() => undefined);
    await fs.copyFile(LEGACY_WIPE_MARKER_PATH, WIPE_MARKER_PATH).catch(() => undefined);
    console.log(`[bootstrap-agent-runtime] Legacy wipe skipped (marker exists: ${LEGACY_WIPE_MARKER_PATH}).`);
    return;
  }

  const hasLegacyTables = await legacyAiTablesExist();
  const deletedMessages = hasLegacyTables
    ? await db.delete(aiMessages).returning({ id: aiMessages.id })
    : [];
  const deletedSessions = hasLegacyTables
    ? await db.delete(aiSessions).returning({ id: aiSessions.id })
    : [];

  const markerContent = {
    doneAt: new Date().toISOString(),
    deleted: {
      aiMessages: deletedMessages.length,
      aiSessions: deletedSessions.length,
    },
  };

  await writeTextAtomic(WIPE_MARKER_PATH, JSON.stringify(markerContent, null, 2)).catch(async () => {
    await fs.mkdir(AGENT_STORAGE_DIR, { recursive: true }).catch(() => undefined);
    await fs.writeFile(LEGACY_WIPE_MARKER_PATH, `${JSON.stringify(markerContent, null, 2)}\n`, 'utf8');
  });

  console.log(
    `[bootstrap-agent-runtime] Legacy wipe done (messages=${deletedMessages.length}, sessions=${deletedSessions.length}).`,
  );
}

async function legacyAiTablesExist(): Promise<boolean> {
  const sqlite = await openDb();
  try {
    const rows = sqlite.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
      ['ai_sessions', 'ai_messages'],
    ) as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    return names.has('ai_sessions') && names.has('ai_messages');
  } finally {
    sqlite.close();
  }
}

async function main() {
  // Load database modules dynamically after env bootstrap so DATA/path aliases are available.
  try {
    const dbModule = await import('../app/lib/db/index');
    const schemaModule = await import('../app/lib/db/schema');
    db = dbModule.db;
    openDb = dbModule.openDb;
    aiMessages = schemaModule.aiMessages;
    aiSessions = schemaModule.aiSessions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Database module not available during bootstrap-agent-runtime: ${message}`);
  }

  // First migrate any legacy files from old locations
  await migrateLegacyFiles();
  
  // Then ensure new files exist
  await ensureIntegrationsEnvBootstrap();
  await ensureAgentStorageBootstrap();
  await ensureSeedPluginsBootstrap();
  await ensureSeedSkillsBootstrap();
  await runLegacySessionCleanupIfNeeded();

  console.log('[bootstrap-agent-runtime] Agent runtime bootstrap complete.');
  console.log(`[bootstrap-agent-runtime] Agent files location: ${CANVAS_AGENT_STORAGE_DIR}`);
  console.log(`[bootstrap-agent-runtime] Runtime config location: ${SETTINGS_STORAGE_DIR}`);
  console.log(`[bootstrap-agent-runtime] Secrets location: ${SECRETS_DIR}`);
}

main().catch((error) => {
  console.error('[bootstrap-agent-runtime] Failed:', error);
  process.exit(1);
});
