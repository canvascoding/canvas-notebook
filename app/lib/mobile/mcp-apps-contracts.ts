import type { CallToolResult } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { McpAccessError } from '@/app/lib/mcp/access';
import type { PersonalMcpAppDescriptor } from '@/app/lib/mcp/apps-types';

/** Native protocol v1 supports personal descriptors only; shared v2 is a later contract. */
export type MobileMcpApp = PersonalMcpAppDescriptor;
export const MOBILE_MCP_ARGUMENT_BYTES = 32 * 1024;
export const MOBILE_MCP_RESULT_BYTES = 2 * 1024 * 1024;
export const MOBILE_MCP_REQUEST_BYTES = 64 * 1024;
export const MOBILE_MCP_APPROVAL_TTL = 120_000;
export const MOBILE_MCP_EXECUTION_TTL = 90_000;
export const MOBILE_MCP_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export type MobileMcpCallStatus = 'prepared' | 'rejected' | 'executing' | 'completed' | 'failed' | 'unknown' | 'expired';
export type MobileMcpCall = {
  callId: string; requestId: string; toolCallId: string; app: MobileMcpApp; tool: string;
  requestDigest: string; authVersion: number; status: MobileMcpCallStatus;
  createdAt: number; updatedAt: number; approvalExpiresAt: number; executionDeadlineAt: number | null;
  result?: CallToolResult; errorCode?: string;
};
export type MobileMcpApproval = { tool: string; arguments: Record<string, unknown>; expiresAt: number; token: string };
export type MobileMcpSource = { toolCallId: string; app: MobileMcpApp };
export type MobileMcpPrepare = MobileMcpSource & {
  hostChannelId: string; requestId: string; tool: string; arguments: Record<string, unknown>;
};

export function mcpInvalidRequest(): never {
  throw new McpAccessError('Invalid MCP app request.', 400, 'MCP_INVALID_REQUEST');
}
export function isMobileMcpRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
/** Deterministic JSON also rejects prototype keys and unbounded nesting before signing. */
export function mobileMcpCanonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) return mcpInvalidRequest();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => mobileMcpCanonicalJson(item, depth + 1)).join(',')}]`;
  if (isMobileMcpRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return mcpInvalidRequest();
    return `{${keys.map(key => `${JSON.stringify(key)}:${mobileMcpCanonicalJson(value[key], depth + 1)}`).join(',')}}`;
  }
  return mcpInvalidRequest();
}
export function readMobileMcpApp(value: unknown): MobileMcpApp {
  if (!isMobileMcpRecord(value) || Object.keys(value).some(key => !['version','connectionId','toolName','resourceUri'].includes(key))
    || value.version !== 1 || typeof value.connectionId !== 'string' || !MOBILE_MCP_UUID.test(value.connectionId)
    || typeof value.toolName !== 'string' || !value.toolName || value.toolName.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.toolName)
    || typeof value.resourceUri !== 'string' || value.resourceUri.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.resourceUri) || !/^ui:\/\/[^\s]+$/u.test(value.resourceUri)) return mcpInvalidRequest();
  return { version: 1, connectionId: value.connectionId, toolName: value.toolName, resourceUri: value.resourceUri };
}
export function readMobileMcpSource(body: Record<string, unknown>): MobileMcpSource {
  if (body.contractVersion !== 1 || typeof body.toolCallId !== 'string' || !body.toolCallId || body.toolCallId.length > 200 || /[\u0000-\u001f\u007f]/u.test(body.toolCallId)) return mcpInvalidRequest();
  return { toolCallId: body.toolCallId, app: readMobileMcpApp(body.app) };
}
export function readMobileMcpRender(body: Record<string, unknown>): MobileMcpSource {
  if (Object.keys(body).some(key => !['contractVersion','toolCallId','app'].includes(key))) return mcpInvalidRequest();
  return readMobileMcpSource(body);
}
export function readMobileMcpPrepare(body: Record<string, unknown>): MobileMcpPrepare {
  if (Object.keys(body).some(key => !['contractVersion','toolCallId','app','hostChannelId','requestId','tool','arguments'].includes(key))
    || typeof body.hostChannelId !== 'string' || !MOBILE_MCP_UUID.test(body.hostChannelId)
    || typeof body.requestId !== 'string' || !MOBILE_MCP_UUID.test(body.requestId)
    || typeof body.tool !== 'string' || !body.tool || body.tool.length > 256 || /[\u0000-\u001f\u007f]/u.test(body.tool) || !isMobileMcpRecord(body.arguments)) return mcpInvalidRequest();
  const json = mobileMcpCanonicalJson(body.arguments);
  if (Buffer.byteLength(json, 'utf8') > MOBILE_MCP_ARGUMENT_BYTES) throw new McpAccessError('Tool arguments are too large.', 413, 'MCP_INVALID_REQUEST');
  return { ...readMobileMcpSource(body), hostChannelId: body.hostChannelId, requestId: body.requestId,
    tool: body.tool, arguments: JSON.parse(json) as Record<string, unknown> };
}
export function readMobileMcpDecision(body: Record<string, unknown>) {
  if (body.contractVersion !== 1 || Object.keys(body).some(key => !['contractVersion','decision','approvalToken'].includes(key))
    || !['approve','reject'].includes(String(body.decision)) || typeof body.approvalToken !== 'string'
    || !/^mca1\.[A-Za-z0-9_-]{43}$/u.test(body.approvalToken)) return mcpInvalidRequest();
  return { decision: body.decision as 'approve' | 'reject', approvalToken: body.approvalToken };
}
export function readMobileMcpResult(value: unknown): CallToolResult {
  const parsed = CallToolResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.content.length > 1000) throw new McpAccessError('The MCP tool returned an invalid result.', 422, 'MCP_SOURCE_INVALID');
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MOBILE_MCP_RESULT_BYTES) {
    throw new McpAccessError('The MCP tool result is too large.', 413, 'MCP_RESULT_TOO_LARGE');
  }
  return parsed.data;
}
