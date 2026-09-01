import { NextRequest, NextResponse } from "next/server";

import { requireWorkspaceMailboxAdmin } from "@/app/lib/email/workspace-mailbox-admin-auth";
import {
  testAdminWorkspaceMailboxConnection,
  type WorkspaceMailboxSmtpInput,
} from "@/app/lib/email/workspace-mailbox-store";
import { rateLimit } from "@/app/lib/utils/rate-limit";

export async function POST(request: NextRequest) {
  const admin = await requireWorkspaceMailboxAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: "admin-workspace-mailbox-test-draft",
  });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json(
        { success: false, error: "Invalid workspace mailbox configuration." },
        { status: 400 },
      );
    }
    const data = await testAdminWorkspaceMailboxConnection(
      admin.session.user.id,
      payload as WorkspaceMailboxSmtpInput,
      {
        organizationId: admin.organizationId,
      },
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Workspace mailbox connection test failed.";
    return NextResponse.json(
      { success: false, error: message },
      { status: 400 },
    );
  }
}
