'use client';

import { type ReactNode } from 'react';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

export function HomeHintProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  return (
    <HintProvider page="home" enabled={enabled}>
      {children}
    </HintProvider>
  );
}