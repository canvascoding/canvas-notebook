'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { authClient } from '@/app/lib/auth-client';
import { getNotebookQueryClient } from '@/app/lib/queries/client';

export function NotebookQueryProvider({ children }: { children: ReactNode }) {
  // Reuse the existing authentication atom and its synchronous invalidation.
  authClient.useSession();
  return <QueryClientProvider client={getNotebookQueryClient()}>{children}</QueryClientProvider>;
}
