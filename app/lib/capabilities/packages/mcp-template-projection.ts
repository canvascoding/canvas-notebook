import 'server-only';

import path from 'node:path';
import { hasMcpCredentialUrl, mcpCredentialArgIndices } from '@/app/lib/mcp/credential-fields';
import { CapabilityPackageError } from './contracts';

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;
const referencePattern = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
const absolutePath = (value: string) => path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);

/** A template is a portable setup suggestion, never an existing connection or credentials export. */
export function projectCapabilityPackageMcpTemplateConfig(input: Record<string, unknown>, connector: string): {
  config: Record<string, unknown>; redactedFields: string[];
} {
  let raw = input;
  if ('mcpServers' in input) {
    if (!object(input.mcpServers) || !Object.hasOwn(input.mcpServers, connector) || !object(input.mcpServers[connector])) {
      throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The declared MCP template was not found.', 404);
    }
    raw = input.mcpServers[connector];
  }
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 64 * 1024) {
    throw new CapabilityPackageError('PACKAGE_LIMIT_EXCEEDED', 'The MCP template exceeds its size limit.', 413);
  }
  const config: Record<string, unknown> = {}, redacted = new Set<string>();
  const publicUrl = (value: unknown): value is string => {
    if (!text(value) || referencePattern.test(value) || hasMcpCredentialUrl(value)) return false;
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash; }
    catch { return false; }
  };
  if ('url' in raw) {
    if (publicUrl(raw.url)) config.url = raw.url;
    else redacted.add('url');
  }
  if ('command' in raw) {
    if (text(raw.command) && /^[A-Za-z0-9_.-]+$/u.test(raw.command)) config.command = raw.command;
    else redacted.add('command');
  }
  if (Array.isArray(raw.args)) {
    const args = raw.args.filter(text), credentialIndices = mcpCredentialArgIndices(args);
    // Do not shift positional arguments. A template requiring hidden values must be completed explicitly.
    config.args = args.map((value, index) => {
      if (credentialIndices.has(index) || absolutePath(value) || /(?:^|=)(?:[A-Za-z]:[\\/]|\/)/u.test(value)) {
        redacted.add(`args.${index}`); return '';
      }
      return value;
    });
    if (args.length !== raw.args.length) redacted.add('args');
  }
  if ('cwd' in raw) redacted.add('cwd');
  for (const field of ['env', 'headers'] as const) {
    if (!object(raw[field])) continue;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw[field])) {
      if (!keyPattern.test(key) && field === 'env' || !text(key)) { redacted.add(field); continue; }
      if (text(value) && referencePattern.test(value)) values[key] = value;
      else if (field === 'headers' && ['accept', 'content-type'].includes(key.toLowerCase()) && text(value) && /^[A-Za-z0-9*+./;=, -]+$/u.test(value)) values[key] = value;
      else { redacted.add(`${field}.${key}`); values[key] = ''; }
    }
    if (Object.keys(values).length) config[field] = values;
  }
  if (object(raw.headersFromEnv)) {
    const headers = Object.fromEntries(Object.entries(raw.headersFromEnv).filter(([key, value]) => text(key) && typeof value === 'string' && keyPattern.test(value)));
    if (Object.keys(headers).length) config.headersFromEnv = headers;
  }
  if (typeof raw.bearerTokenEnv === 'string' && keyPattern.test(raw.bearerTokenEnv)) config.bearerTokenEnv = raw.bearerTokenEnv;
  if (Array.isArray(raw.envPassthrough)) config.envPassthrough = raw.envPassthrough.filter((value): value is string => typeof value === 'string' && keyPattern.test(value));
  if (raw.auth === 'oauth' || raw.auth === 'none') config.auth = raw.auth;
  if (raw.transport === 'http' || raw.transport === 'stdio') config.transport = raw.transport;
  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
  if (object(raw.oauth)) {
    const oauth: Record<string, unknown> = {};
    for (const field of ['issuer', 'resourceMetadataUrl', 'authorizationUrl', 'tokenUrl', 'registrationUrl', 'revocationUrl']) {
      if (!(field in raw.oauth)) continue;
      if (publicUrl(raw.oauth[field])) oauth[field] = raw.oauth[field];
      else redacted.add(`oauth.${field}`);
    }
    if (Array.isArray(raw.oauth.scopes)) oauth.scopes = raw.oauth.scopes.filter(text);
    // Registration, client identities and client secrets remain managed by the connection service.
    for (const field of Object.keys(raw.oauth)) if (!(field in oauth)) redacted.add(`oauth.${field}`);
    if (Object.keys(oauth).length) config.oauth = oauth;
  }
  return { config, redactedFields: [...redacted].sort() };
}
