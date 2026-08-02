import * as Sentry from "@sentry/nextjs";
import {
  isDatabaseUnavailableError,
  isSqliteDatabaseUnavailableError,
} from "@/app/lib/db/errors";
import { assertProductionAuthSecret } from "@/app/lib/security/auth-secret";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      assertProductionAuthSecret();
    }
    await import("./sentry.server.config");
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { initializeDelegationDispatcher } = await import("./app/lib/pi/delegation-dispatcher");
      void initializeDelegationDispatcher().catch((error) => {
        console.error("[Instrumentation] Delegation dispatcher initialization failed:", error);
      });
      const { initializeCommunityLicenseRefreshRuntime } = await import("./app/lib/license/refresh");
      initializeCommunityLicenseRefreshRuntime();
      const { initializeTeamLicenseLifecycleRuntime } = await import("./app/lib/license/team-license-lifecycle");
      initializeTeamLicenseLifecycleRuntime();
      const { initializeTeamMembershipSnapshotSyncRuntime } = await import("./app/lib/license/team-membership-sync");
      initializeTeamMembershipSnapshotSyncRuntime();
      const { initializeTeamSeatOutboxWorkerRuntime } = await import("./app/lib/license/team-seat-outbox-worker");
      initializeTeamSeatOutboxWorkerRuntime();
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

function shouldSuppressDevelopmentRequestError(error: unknown): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  return isDatabaseUnavailableError(error) || isSqliteDatabaseUnavailableError(error);
}

export const onRequestError: typeof Sentry.captureRequestError = (error, request, context) => {
  if (shouldSuppressDevelopmentRequestError(error)) {
    return;
  }
  return Sentry.captureRequestError(error, request, context);
};
