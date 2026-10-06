import 'server-only';

import { createHash } from 'node:crypto';
import type { McpServerConfig } from './config';
import { credentialEnvKey, decodeMcpCredentialEnvelope, removeMcpCredentialJson, writeMcpCredentialJson } from './credential-storage';
import { requireMcpCredentialScope, resolveMcpSecretEnvScope, type McpScope } from './scope';
import { readUnifiedEnvState } from '@/app/lib/secrets/unified-env-store';
import { authorizeSharedMcpScope } from './shared-access';
import { IntegrationContractError } from '@/app/lib/integration-tools/contracts';
import { readIntegrationContractErrorCode } from '@/app/lib/integration-tools/agent-errors';

export type SharedMcpSecretSlot = { name: string; envKey: string; relativePath: string };

export function sharedMcpSecretSlot(scope: McpScope, name: string): SharedMcpSecretSlot {
  const owned = requireMcpCredentialScope(scope);
  if (!owned.shared || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name)) throw new Error('Invalid shared MCP secret slot.');
  const digest = createHash('sha256').update(name).digest('hex');
  const relativePath = `connections/${owned.shared.connectionId}/slot-${digest}.json`;
  return { name, relativePath, envKey: credentialEnvKey(relativePath) };
}

export function sharedMcpSecretSlots(config: McpServerConfig, scope: McpScope): SharedMcpSecretSlot[] {
  const slots = config.sharedSecretSlots ?? [];
  if (!Array.isArray(slots) || slots.length > 50) throw new Error('Invalid shared MCP secret slots.');
  const result = slots.map(slot => {
    if (!slot || typeof slot !== 'object' || Object.keys(slot).sort().join(',') !== 'envKey,name,relativePath') throw new Error('Invalid shared MCP secret slot.');
    const expected = sharedMcpSecretSlot(scope, (slot as SharedMcpSecretSlot).name);
    if ((slot as SharedMcpSecretSlot).envKey !== expected.envKey || (slot as SharedMcpSecretSlot).relativePath !== expected.relativePath) throw new Error('Shared MCP secret slot belongs to another resource.');
    return expected;
  });
  if (new Set(result.map(slot => slot.name)).size !== result.length) throw new Error('Duplicate shared MCP secret slot.');
  return result;
}

/** Only generated slots belonging to this resource enter its provider environment. */
export async function readSharedMcpEnvironment(scope: McpScope, config: McpServerConfig): Promise<{ values: Record<string, string>; revision: string }> {
  try {
  const owned = requireMcpCredentialScope(scope);
  await authorizeSharedMcpScope(owned);
  const state = await readUnifiedEnvState(resolveMcpSecretEnvScope(owned));
  const values: Record<string, string> = {};
  const selected: Array<[string, string | null]> = [];
  for (const slot of sharedMcpSecretSlots(config, owned)) {
    const entry = state.entries.find(item => item.key === slot.envKey);
    selected.push([slot.envKey, entry?.value ?? null]);
    if (!entry || entry.value === 'null') continue;
    if (!entry.readable) throw new Error('The shared MCP secret cannot be decrypted. Configure it in /settings?tab=secrets.');
    const payload = await decodeMcpCredentialEnvelope<{ value: string; name: string }>(entry.value, slot.relativePath, owned);
    if (payload.name !== slot.name || typeof payload.value !== 'string') throw new Error('Invalid shared MCP secret payload.');
    values[slot.envKey] = payload.value;
  }
  await authorizeSharedMcpScope(owned);
  return { values: Object.freeze(values), revision: createHash('sha256').update(JSON.stringify(selected)).digest('hex') };
  } catch (error) {
    if (readIntegrationContractErrorCode(error)) throw error;
    throw new IntegrationContractError('provider_unavailable', 'The shared MCP credential slots are unavailable. Review the connection settings.');
  }
}

export async function writeSharedMcpSecretSlot(scope: McpScope, slot: SharedMcpSecretSlot, value: string | null): Promise<void> {
  const owned = requireMcpCredentialScope(scope);
  await authorizeSharedMcpScope(owned, 'manage');
  const canonical = sharedMcpSecretSlot(owned, slot.name);
  if (canonical.envKey !== slot.envKey || canonical.relativePath !== slot.relativePath) throw new Error('Invalid shared MCP secret slot.');
  if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024 || value.includes('\0'))) throw new Error('Invalid shared MCP secret value.');
  if (value === null) return removeMcpCredentialJson(slot.relativePath, { ...owned, shared: { ...owned.shared!, operation: 'manage' } });
  await writeMcpCredentialJson(slot.relativePath, { connectionId: owned.shared!.connectionId, organizationId: owned.organizationId,
    name: slot.name, value: value ?? '' }, { ...owned, shared: { ...owned.shared!, operation: 'manage' } });
}
