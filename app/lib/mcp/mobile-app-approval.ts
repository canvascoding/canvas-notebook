import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';
import { mobileMcpCanonicalJson } from '@/app/lib/mobile/mcp-apps-contracts';
import type { MobileMcpCallRecord } from './mobile-app-call-store';

export function mobileMcpApprovalToken(call: MobileMcpCallRecord): string {
  const payload = { purpose: 'canvas.mobile.mcp.approval.v1', callId: call.callId, userId: call.actor.userId,
    authSessionId: call.actor.authSessionId, workspaceId: call.actor.workspaceId, sessionId: call.actor.sessionId,
    agentId: call.actor.agentId, sourceReceiptDigest: call.sourceReceiptDigest, requestDigest: call.requestDigest,
    authVersion: call.authVersion, expiresAt: call.approvalExpiresAt };
  return `mca1.${createHmac('sha256', resolveAuthSecret()).update(mobileMcpCanonicalJson(payload)).digest('base64url')}`;
}
export function matchesMobileMcpApproval(call: MobileMcpCallRecord, token: string): boolean {
  const expected = Buffer.from(mobileMcpApprovalToken(call));
  const supplied = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
