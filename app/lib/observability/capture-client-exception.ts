'use client';

import * as Sentry from '@sentry/nextjs';

interface ClientExceptionContext {
  boundary: string;
  componentStack?: string | null;
  digest?: string;
  tags?: Record<string, string | undefined>;
}

/**
 * Records browser exceptions with consistent, non-sensitive context so UI
 * error boundaries can be correlated without exposing the error to users.
 */
export function captureClientException(error: unknown, context: ClientExceptionContext) {
  Sentry.withScope((scope) => {
    scope.setTag('client.boundary', context.boundary);

    for (const [name, value] of Object.entries(context.tags ?? {})) {
      if (value) scope.setTag(name, value);
    }

    if (context.digest) scope.setTag('next.digest', context.digest);
    if (context.componentStack) scope.setExtra('react.component_stack', context.componentStack);

    Sentry.captureException(error);
  });
}
