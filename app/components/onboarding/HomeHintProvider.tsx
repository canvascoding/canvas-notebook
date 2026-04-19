'use client';

import { type ReactNode } from 'react';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

export function HomeHintProvider({ children }: { children: ReactNode }) {
  return (
    <HintProvider page="home">
      {children}
    </HintProvider>
  );
}