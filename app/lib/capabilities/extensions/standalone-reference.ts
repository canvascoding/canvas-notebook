import { createHash } from 'node:crypto';

export type StandaloneExtensionSlot = Readonly<{
  configurationId: string;
  source: 'mcp' | 'composio';
  toolkit?: string;
}>;

const slotReference = /^agent-extension:[A-Za-z0-9_-]{43}$/u;
const canonicalToolkit = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

/**
 * Stable preference slot within one agent, independent of the user's chosen
 * account. This identifier grants no read, use, binding or routing authority.
 * Actual preference storage is scoped by agent/user and its workflow revision.
 */
export function createStandaloneExtensionSlotRef(slot: StandaloneExtensionSlot): string {
  if (!slot || typeof slot !== 'object'
    || Object.keys(slot).some(key => !['configurationId', 'source', 'toolkit'].includes(key))
    || typeof slot.configurationId !== 'string' || !slot.configurationId
    || slot.configurationId.length > 256 || slot.configurationId !== slot.configurationId.trim()
    || /[\p{Cc}\p{Cf}]/u.test(slot.configurationId)
    || !['mcp', 'composio'].includes(slot.source)
    || (slot.source === 'composio'
      ? typeof slot.toolkit !== 'string' || !canonicalToolkit.test(slot.toolkit)
      : slot.toolkit !== undefined)) {
    throw new Error('A canonical standalone extension slot is required.');
  }
  const identity = [slot.configurationId, slot.source, slot.toolkit ?? null];
  return `agent-extension:${createHash('sha256').update(JSON.stringify(identity)).digest('base64url')}`;
}

/** Syntax check only; a matching string is never proof of an existing grant. */
export function isStandaloneExtensionSlotRef(value: unknown): value is string {
  return typeof value === 'string' && slotReference.test(value);
}
