import type { ReactNode } from 'react';

import { StudioChatProvider } from '@/app/apps/studio/context/studio-chat-context';
import { StudioShell } from '@/app/components/StudioShell';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';

export default function StudioLayout({ children }: { children: ReactNode }) {
  return (
    <StudioChatProvider>
      <StudioShell hintEnabled={isOnboardingHintsEnabled()}>{children}</StudioShell>
    </StudioChatProvider>
  );
}
