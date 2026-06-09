import type { ReactNode } from 'react';

import { EmailChatProvider } from '@/app/apps/email/context/email-chat-context';
import { EmailShell } from '@/app/components/EmailShell';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';

export default function EmailsLayout({ children }: { children: ReactNode }) {
  return (
    <EmailChatProvider>
      <EmailShell hintEnabled={isOnboardingEnabled()}>{children}</EmailShell>
    </EmailChatProvider>
  );
}
