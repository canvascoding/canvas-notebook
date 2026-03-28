const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENCRYPTED_PREFIX = 'enc:v1';
const CONTAINER_DATA_ROOT = '/data';
const VALID_ENV_SCOPES = new Set(['integrations', 'agents', 'none']);
const VALID_INSTALL_STRATEGIES = new Set(['none', 'npm']);
const DEFAULT_GLOBAL_WRAPPER_DIR = '/usr/local/bin';

function directoryExists(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function envFlagEnabled(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveCanvasDataRoot(cwd = process.cwd()) {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (directoryExists(CONTAINER_DATA_ROOT)) {
    return CONTAINER_DATA_ROOT;
  }

  return path.resolve(cwd, 'data');
}

function resolveSkillsDataDir(cwd = process.cwd()) {
  return path.join(resolveCanvasDataRoot(cwd), 'skills');
}

function resolveSecretsDir(cwd = process.cwd()) {
  return path.join(resolveCanvasDataRoot(cwd), 'secrets');
}

function resolveEnvFilePath(scope, cwd = process.cwd()) {
  const envName = scope === 'agents' ? 'AGENTS_ENV_PATH' : 'INTEGRATIONS_ENV_PATH';
  const configured = process.env[envName]?.trim();
  if (configured) {
    return configured;
  }

  const fileName = scope === 'agents' ? 'Canvas-Agents.env' : 'Canvas-Integrations.env';
  return path.join(resolveSecretsDir(cwd), fileName);
}

function parseEnv(content) {
  const entries = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!key) {
      continue;
    }

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.push({ key, value });
  }

  return entries;
}

function deriveEncryptionKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function decryptValue(value, secret) {
  if (!value.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    return value;
  }

  const parts = value.split(':');
  if (parts.length !== 5) {
    throw new Error('Invalid encrypted value format');
  }

  const [, version, ivHex, tagHex, encryptedHex] = parts;
  if (version !== 'v1') {
    throw new Error(`Unsupported encrypted value version: ${version}`);
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveEncryptionKey(secret),
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

function readScopedEnvMap(scope, cwd = process.cwd()) {
  if (scope === 'none') {
    return {};
  }

  const filePath = resolveEnvFilePath(scope, cwd);
  let rawContent = '';
  try {
    rawContent = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  const masterKeyEnvName = scope === 'agents' ? 'AGENTS_ENV_MASTER_KEY' : 'INTEGRATIONS_ENV_MASTER_KEY';
  const secret = process.env[masterKeyEnvName]?.trim() || null;
  const entries = parseEnv(rawContent);
  const env = {};

  for (const entry of entries) {
    try {
      env[entry.key] = secret ? decryptValue(entry.value, secret) : entry.value;
    } catch {
      env[entry.key] = '';
    }
  }

  return env;
}

function validateCommandSpec(rawCommand, skillDir, skillName) {
  if (!rawCommand || typeof rawCommand !== 'object') {
    throw new Error(`Skill "${skillName}" has an invalid command entry.`);
  }

  const command = rawCommand;
  const name = typeof command.name === 'string' ? command.name.trim() : '';
  const exec = Array.isArray(command.exec) ? command.exec.filter((item) => typeof item === 'string' && item.trim()) : [];
  const envScope = typeof command.envScope === 'string' ? command.envScope : 'none';
  const installStrategy = typeof command.installStrategy === 'string' ? command.installStrategy : 'none';
  const description = typeof command.description === 'string' && command.description.trim()
    ? command.description.trim()
    : null;

  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Skill "${skillName}" has a command with an invalid name.`);
  }
  if (exec.length === 0) {
    throw new Error(`Skill "${skillName}" command "${name}" is missing a valid exec definition.`);
  }
  if (!VALID_ENV_SCOPES.has(envScope)) {
    throw new Error(`Skill "${skillName}" command "${name}" has an unsupported envScope "${envScope}".`);
  }
  if (!VALID_INSTALL_STRATEGIES.has(installStrategy)) {
    throw new Error(`Skill "${skillName}" command "${name}" has an unsupported installStrategy "${installStrategy}".`);
  }

  return {
    skillName,
    skillDir,
    name,
    exec,
    envScope,
    installStrategy,
    description,
  };
}

function listSkillCommandSpecs(options = {}) {
  const cwd = options.cwd || process.cwd();
  const skillsDir = options.skillsDir || resolveSkillsDataDir(cwd);
  if (!directoryExists(skillsDir)) {
    return [];
  }

  const specs = [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'bin' || entry.name.startsWith('.')) {
      continue;
    }

    const skillDir = path.join(skillsDir, entry.name);
    const manifestPath = path.join(skillDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const skillName = typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim()
      : entry.name;
    const rawCommands = Array.isArray(manifest.commands) ? manifest.commands : [];

    for (const rawCommand of rawCommands) {
      specs.push(validateCommandSpec(rawCommand, skillDir, skillName));
    }
  }

  return specs;
}

function resolveCommandSpec(commandName, options = {}) {
  const specs = listSkillCommandSpecs(options);
  const spec = specs.find((entry) => entry.name === commandName);
  if (!spec) {
    throw new Error(`Unknown skill command: ${commandName}`);
  }
  return spec;
}

function canAutoInstallDependencies(skillsDir) {
  const normalized = path.resolve(skillsDir);
  return normalized === '/data/skills' || normalized.startsWith('/data/skills/');
}

function ensureDependencies(spec, options = {}) {
  if (spec.installStrategy !== 'npm') {
    return;
  }

  const skillsDir = options.skillsDir || resolveSkillsDataDir(options.cwd || process.cwd());
  if (!canAutoInstallDependencies(skillsDir)) {
    return;
  }

  const packageJsonPath = path.join(spec.skillDir, 'package.json');
  const nodeModulesPath = path.join(spec.skillDir, 'node_modules');
  if (!fs.existsSync(packageJsonPath) || fs.existsSync(nodeModulesPath)) {
    return;
  }

  execFileSync('npm', ['install', '--omit=dev'], {
    cwd: spec.skillDir,
    stdio: 'pipe',
  });
}

function maybeResolveSkillPath(skillDir, value) {
  if (typeof value !== 'string' || !value.trim()) {
    return value;
  }
  if (path.isAbsolute(value)) {
    return value;
  }

  const candidate = path.join(skillDir, value);
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  return value;
}

function resolveExec(commandSpec) {
  const [rawCommand, ...rawArgs] = commandSpec.exec;
  const command = maybeResolveSkillPath(commandSpec.skillDir, rawCommand);
  const args = rawArgs.map((value) => maybeResolveSkillPath(commandSpec.skillDir, value));
  return { command, args };
}

function buildWrapperContent(launcherPath, commandName) {
  return `#!/usr/bin/env bash\nexec node "${launcherPath}" "${commandName}" "$@"\n`;
}

function ensureWrapperDirectory(wrapperDir) {
  fs.mkdirSync(wrapperDir, { recursive: true });
  for (const entry of fs.readdirSync(wrapperDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.unlinkSync(path.join(wrapperDir, entry.name));
    }
  }
}

function canWriteDirectory(targetDir) {
  if (!directoryExists(targetDir)) {
    return false;
  }

  try {
    fs.accessSync(targetDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function prepareSkillsRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const repoSkillsDir = options.repoSkillsDir || path.resolve(cwd, 'skills');
  const skillsDir = options.skillsDir || resolveSkillsDataDir(cwd);
  const launcherPath = options.launcherPath || path.resolve(cwd, 'scripts', 'run-skill-command.js');
  const globalWrapperDir = options.globalWrapperDir || process.env.CANVAS_SKILLS_GLOBAL_WRAPPER_DIR || DEFAULT_GLOBAL_WRAPPER_DIR;
  const installGlobalWrappers =
    options.installGlobalWrappers ?? envFlagEnabled(process.env.CANVAS_SKILLS_INSTALL_GLOBAL_WRAPPERS);

  fs.mkdirSync(skillsDir, { recursive: true });
  if (directoryExists(repoSkillsDir)) {
    fs.cpSync(repoSkillsDir, skillsDir, { recursive: true, force: true });
  }

  const commandSpecs = listSkillCommandSpecs({ cwd, skillsDir });
  const wrapperDir = path.join(skillsDir, 'bin');
  ensureWrapperDirectory(wrapperDir);

  for (const spec of commandSpecs) {
    const wrapperPath = path.join(wrapperDir, spec.name);
    fs.writeFileSync(wrapperPath, buildWrapperContent(launcherPath, spec.name), {
      encoding: 'utf8',
      mode: 0o755,
    });
  }

  if (installGlobalWrappers && canWriteDirectory(globalWrapperDir)) {
    for (const spec of commandSpecs) {
      fs.writeFileSync(path.join(globalWrapperDir, spec.name), buildWrapperContent(launcherPath, spec.name), {
        encoding: 'utf8',
        mode: 0o755,
      });
    }
  } else if (installGlobalWrappers) {
    console.warn(
      `[skills-runtime] Skipping global wrapper install because ${globalWrapperDir} is not writable. Using ${wrapperDir} via PATH instead.`,
    );
  }

  const currentPath = process.env.PATH || '';
  if (!currentPath.split(path.delimiter).includes(wrapperDir)) {
    process.env.PATH = `${wrapperDir}${path.delimiter}${currentPath}`;
  }

  return { skillsDir, wrapperDir, commandSpecs };
}

function runSkillCommand(commandName, commandArgs, options = {}) {
  const cwd = options.cwd || process.cwd();
  const skillsDir = options.skillsDir || resolveSkillsDataDir(cwd);
  const spec = resolveCommandSpec(commandName, { cwd, skillsDir });
  ensureDependencies(spec, { cwd, skillsDir });

  const scopedEnv = readScopedEnvMap(spec.envScope, cwd);
  const childEnv = {
    ...process.env,
    ...scopedEnv,
  };

  const { command, args } = resolveExec(spec);
  const result = spawnSync(command, [...args, ...commandArgs], {
    cwd: options.executionCwd || process.cwd(),
    env: childEnv,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 0;
}

module.exports = {
  prepareSkillsRuntime,
  readScopedEnvMap,
  resolveCanvasDataRoot,
  resolveEnvFilePath,
  resolveSkillsDataDir,
  runSkillCommand,
  listSkillCommandSpecs,
};
