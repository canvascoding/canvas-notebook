/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const DIRECT_MCP_FEATURE_ENV = 'CANVAS_MCP_DIRECT_ENABLED';
const DIRECT_MCP_TOOLS_ENV = 'CANVAS_MCP_DIRECT_TOOLS';
const DIRECT_MCP_SETTINGS_SOURCE_ENV = 'CANVAS_MCP_DIRECT_SETTINGS_SOURCE';
const DIRECT_MCP_TOOLS_SOURCE_ENV = 'CANVAS_MCP_DIRECT_TOOLS_SOURCE';
const DIRECT_MCP_LEGACY_AUTH_PROBE_CONFIGURATION_VERSION = 2;
const DIRECT_MCP_DEFAULT_TOOLS = [
  'auth_probe',
  'list_workspaces',
  'get_workspace_overview',
  'list_knowledge_tree',
  'search_knowledge',
  'read_knowledge_source',
];
const DIRECT_MCP_TOOLS = [
  ...DIRECT_MCP_DEFAULT_TOOLS,
  'edit_knowledge_source',
  'read_knowledge_asset',
];
const DIRECT_MCP_TOOL_SET = new Set(DIRECT_MCP_TOOLS);

function resolveEnvFilePath(filePath, cwd = process.cwd()) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function isDefaultDataEnvValue(value) {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/+$/, '');
  return normalized === 'data';
}

function resolveCanvasDataRoot(cwd) {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) return path.resolve(configured);

  const data = process.env.DATA?.trim();
  if (data && !isDefaultDataEnvValue(data)) {
    return path.isAbsolute(data) ? data : path.resolve(cwd, data);
  }
  if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) return '/data';
  return path.resolve(cwd, 'data');
}

function readDirectMcpPreferences(cwd) {
  const filePath = path.join(
    resolveCanvasDataRoot(cwd),
    'system',
    'settings',
    'server-preferences.json',
  );
  if (!fs.existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const preferences = parsed?.settings?.directMcp;
    if (
      typeof preferences?.enabled !== 'boolean'
      || !Array.isArray(preferences.tools)
      || preferences.tools.some((tool) => typeof tool !== 'string' || !DIRECT_MCP_TOOL_SET.has(tool))
    ) {
      return null;
    }
    const tools = [...new Set(preferences.tools)];
    const toolsVersion = Number.isSafeInteger(preferences.toolsVersion)
      ? preferences.toolsVersion
      : 1;
    const isLegacyAuthProbeDefault = toolsVersion < DIRECT_MCP_LEGACY_AUTH_PROBE_CONFIGURATION_VERSION
      && tools.length === 1
      && tools[0] === 'auth_probe';
    return {
      enabled: preferences.enabled,
      tools: isLegacyAuthProbeDefault ? [...DIRECT_MCP_DEFAULT_TOOLS] : tools,
    };
  } catch (error) {
    console.warn('[Startup] Ignoring invalid Direct MCP server preferences.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function loadDirectMcpPreferences(cwd) {
  const preferences = readDirectMcpPreferences(cwd);
  const featureWasLoadedFromSettings = process.env[DIRECT_MCP_SETTINGS_SOURCE_ENV] === 'settings';
  const toolsWereLoadedFromSettings = process.env[DIRECT_MCP_TOOLS_SOURCE_ENV] === 'settings';

  if (process.env[DIRECT_MCP_FEATURE_ENV] === undefined || featureWasLoadedFromSettings) {
    if (preferences) {
      process.env[DIRECT_MCP_FEATURE_ENV] = String(preferences.enabled);
      process.env[DIRECT_MCP_SETTINGS_SOURCE_ENV] = 'settings';
    } else if (featureWasLoadedFromSettings) {
      delete process.env[DIRECT_MCP_FEATURE_ENV];
      delete process.env[DIRECT_MCP_SETTINGS_SOURCE_ENV];
    }
  } else {
    process.env[DIRECT_MCP_SETTINGS_SOURCE_ENV] = 'environment';
  }

  if (process.env[DIRECT_MCP_TOOLS_ENV] === undefined || toolsWereLoadedFromSettings) {
    if (preferences) {
      process.env[DIRECT_MCP_TOOLS_ENV] = preferences.tools.join(',');
      process.env[DIRECT_MCP_TOOLS_SOURCE_ENV] = 'settings';
    } else if (toolsWereLoadedFromSettings) {
      delete process.env[DIRECT_MCP_TOOLS_ENV];
      delete process.env[DIRECT_MCP_TOOLS_SOURCE_ENV];
    }
  } else {
    process.env[DIRECT_MCP_TOOLS_SOURCE_ENV] = 'environment';
  }
}

function loadAppEnv(cwd = process.cwd()) {
  const configuredPath = process.env.CANVAS_ENV_FILE?.trim();
  const defaultPath =
    process.env.CANVAS_RUNTIME_ENV === 'docker'
      ? '.env.docker'
      : process.env.NODE_ENV === 'production'
        ? null
        : '.env.local';
  const selectedPath = configuredPath || defaultPath;
  let resolvedPath = null;
  if (selectedPath) {
    const candidatePath = resolveEnvFilePath(selectedPath, cwd);
    if (fs.existsSync(candidatePath)) {
      dotenv.config({
        path: candidatePath,
        override: false,
      });
      process.env.CANVAS_ENV_FILE = candidatePath;
      resolvedPath = candidatePath;
    }
  }

  loadDirectMcpPreferences(cwd);
  return resolvedPath;
}

module.exports = {
  loadAppEnv,
};
