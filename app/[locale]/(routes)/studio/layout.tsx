import type { ReactNode } from 'react';

import { StudioChatProvider } from '@/app/apps/studio/context/studio-chat-context';
import { StudioShell } from '@/app/components/StudioShell';

export default function StudioLayout({ children }: { children: ReactNode }) {
  return (
    <StudioChatProvider>
      <StudioShell>{children}</StudioShell>
    </StudioChatProvider>
  );
}
