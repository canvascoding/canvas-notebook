import * as Sentry from "@sentry/nextjs";
import {
  isDatabaseUnavailableError,
  isSqliteDatabaseUnavailableError,
} from "@/app/lib/db/errors";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
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
