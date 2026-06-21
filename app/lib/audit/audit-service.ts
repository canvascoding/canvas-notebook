import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { db } from '@/app/lib/db';
import { auditEvents } from '@/app/lib/db/schema';
import { logger } from '@/app/lib/logging';

const auditLogger = logger.module('Audit');
const MAX_METADATA_JSON_LENGTH = 4096;
const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 80;

const SENSITIVE_KEY_PATTERN = /(secret|token|password|passphrase|credential|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key)/i;

export type AuditStatus = 'success' | 'failure' | 'blocked' | 'queued' | 'started' | 'completed';

export interface AuditEventInput {
  organizationId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  source: string;
  eventType: string;
  entityType: string;
  entityId?: string | null;
  action: string;
  status?: AuditStatus;
  summary?: string | null;
  metadata?: unknown;
  input?: unknown;
  output?: unknown;
  inputHash?: string | null;
  outputHash?: string | null;
  artifactRef?: string | null;
  secretRef?: string | null;
  secretScope?: string | null;
  createdAt?: Date;
}

export interface AuditEventRecord {
  id: string;
  createdAt: Date;
}

function normalizeText(value: string | null | undefined, maxLength = 500): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function redactAuditValue(value: unknown, depth = 0, keyHint = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return '[MAX_DEPTH]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redactAuditValue(item, depth + 1, keyHint));
    if (value.length > MAX_ARRAY_LENGTH) items.push(`[${value.length - MAX_ARRAY_LENGTH} more items truncated]`);
    return items;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    for (const [key, entryValue] of entries) {
      result[key] = redactAuditValue(entryValue, depth + 1, key);
    }
    const totalKeys = Object.keys(value as Record<string, unknown>).length;
    if (totalKeys > MAX_OBJECT_KEYS) result.__truncatedKeys = totalKeys - MAX_OBJECT_KEYS;
    return result;
  }
  return String(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(redactAuditValue(value));
}

export function hashAuditValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function serializeAuditMetadata(metadata: unknown): string | null {
  if (metadata === undefined || metadata === null) return null;
  const sanitized = redactAuditValue(metadata);
  const json = JSON.stringify(sanitized);
  if (json.length <= MAX_METADATA_JSON_LENGTH) return json;

  return JSON.stringify({
    truncated: true,
    originalLength: json.length,
    preview: json.slice(0, MAX_METADATA_JSON_LENGTH - 120),
  });
}

export async function recordAuditEvent(input: AuditEventInput): Promise<AuditEventRecord | null> {
  const id = `audit-${randomUUID()}`;
  const createdAt = input.createdAt ?? new Date();

  try {
    await db.insert(auditEvents).values({
      id,
      organizationId: normalizeText(input.organizationId, 200),
      workspaceId: normalizeText(input.workspaceId, 200),
      userId: normalizeText(input.userId, 200),
      sessionId: normalizeText(input.sessionId, 500),
      agentId: normalizeText(input.agentId, 200),
      source: normalizeText(input.source, 80) ?? 'unknown',
      eventType: normalizeText(input.eventType, 80) ?? 'event',
      entityType: normalizeText(input.entityType, 80) ?? 'unknown',
      entityId: normalizeText(input.entityId, 500),
      action: normalizeText(input.action, 120) ?? 'unknown',
      status: input.status ?? 'success',
      summary: normalizeText(input.summary, 500),
      metadataJson: serializeAuditMetadata(input.metadata),
      inputHash: normalizeText(input.inputHash ?? (input.input === undefined ? null : hashAuditValue(input.input)), 128),
      outputHash: normalizeText(input.outputHash ?? (input.output === undefined ? null : hashAuditValue(input.output)), 128),
      artifactRef: normalizeText(input.artifactRef, 500),
      secretRef: normalizeText(input.secretRef, 500),
      secretScope: normalizeText(input.secretScope, 120),
      createdAt,
    });

    return { id, createdAt };
  } catch (error) {
    auditLogger.error('Failed to record audit event', {
      source: input.source,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
