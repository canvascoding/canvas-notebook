import crypto from 'node:crypto';
import path from 'node:path';
import { mcpLiteralEnvKey } from '@/app/lib/mcp/env-references';
import { hasMcpCredentialUrl, mcpCredentialArgIndices } from '@/app/lib/mcp/credential-fields';

const ENV_FILES = new Set(['Canvas-Secrets.env', 'Canvas-Integrations.env', 'Canvas-Agents.env']);
const SECRET_FIELDS = new Set(['apikey', 'accesskey', 'secretaccesskey', 'sessiontoken', 'accesstoken', 'refreshtoken', 'idtoken', 'token', 'password', 'secret', 'clientsecret', 'authorization', 'credentials', 'credential']);
const PURE_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

/** Portable exports never carry managed credential files, even when a custom path falls inside a selected workspace. */
export function isPortableCredentialPath(filePath: string, dataRoot: string): boolean {
  const absolute = path.resolve(filePath);
  for (const name of ['CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'OAUTH_STORAGE_PATH']) {
    const configured = process.env[name]?.trim();
    if (configured && (absolute === path.resolve(configured) || absolute.startsWith(`${path.resolve(configured)}.`))) return true;
  }
  const parts = path.relative(dataRoot, absolute).split(path.sep);
  const scopedRoot = ['users', 'organizations'].includes(parts[0]) ? parts.slice(2) : parts[0] === 'system' ? parts.slice(1) : parts;
  if (scopedRoot[0] === 'secrets' || scopedRoot[0] === 'pi-oauth-states') return true;
  const runtimeRoot = ['settings', 'canvas-agent', 'agents', 'mcp'].includes(scopedRoot[0]);
  return runtimeRoot && (parts.at(-1) === 'auth.json' || ENV_FILES.has(parts.at(-1)!) || scopedRoot.slice(1).some(part => ['connections', 'states', 'oauth-states', 'mcp-oauth', 'email-oauth', 'email-accounts'].includes(part)));
}

function assertPortableUrl(value: string): void {
  if (hasMcpCredentialUrl(value)) throw new Error('Reconnect before exporting credential-bearing runtime URLs.');
}

function assertPortableArgs(value: unknown): void {
  if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string')) throw new Error('Cannot safely export malformed runtime arguments.');
  if (mcpCredentialArgIndices(value).size) throw new Error('Reconnect before exporting literal runtime argument credentials.');
}

export function isPortableRuntimeConfigPath(filePath: string, dataRoot: string): boolean {
  const parts = path.relative(dataRoot, filePath).split(path.sep);
  return ['settings', 'canvas-agent', 'agents'].includes(parts[0]) && ['mcp.json', 'pi-runtime-config.json', 'providers.json'].includes(parts.at(-1)!);
}

/** Restrict scrubbing to known runtime configuration documents; arbitrary workspace content is kept verbatim. */
export function redactPortableRuntimeConfig(raw: string, filePath: string, dataRoot: string): string | null {
  if (!isPortableRuntimeConfigPath(filePath, dataRoot)) return null;
  let config: unknown;
  try { config = JSON.parse(raw); } catch { throw new Error('Cannot safely export malformed runtime configuration.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Cannot safely export malformed runtime configuration.');
  const scrub = (value: unknown, identity: string): unknown => {
    if (Array.isArray(value)) return value.map(item => scrub(item, identity));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (key === 'args') assertPortableArgs(item);
      if (typeof item === 'string' && ['url', 'baseUrl', 'endpoint', 'issuer'].includes(key)) assertPortableUrl(item);
      if (key === 'auth' && item !== 'none' && item !== 'oauth') throw new Error('Cannot safely export malformed runtime authentication configuration.');
      if (SECRET_FIELDS.has(key.replace(/[_-]/gu, '').toLowerCase())) {
        return typeof item === 'string' && PURE_REFERENCE.test(item) ? [[key, item]] : [];
      }
      if (key === 'env' || key === 'headers') {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Cannot safely export malformed runtime environment bindings.');
        const references = Object.fromEntries(Object.entries(item).map(([name, content]) => {
          if (typeof content !== 'string') throw new Error('Cannot safely export malformed runtime environment bindings.');
          return [name, PURE_REFERENCE.test(content) ? content : `\${${mcpLiteralEnvKey(identity, key, name)}}`];
        }));
        return [[key, references]];
      }
      const childIdentity = key === 'mcpServers' || key === 'providers' ? undefined : identity;
      if (childIdentity === undefined && item && typeof item === 'object' && !Array.isArray(item)) {
        return [[key, Object.fromEntries(Object.entries(item).map(([name, definition]) => {
          const connectionId = (definition as { connectionId?: unknown })?.connectionId;
          const id = typeof connectionId === 'string' ? connectionId : `system-${crypto.createHash('sha256').update(name).digest('hex')}`;
          return [name, scrub(definition, id)];
        }))]];
      }
      return [[key, scrub(item, identity)]];
    }));
  };
  return `${JSON.stringify(scrub(config, 'portable-runtime'), null, 2)}\n`;
}
