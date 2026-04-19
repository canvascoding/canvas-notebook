'use client';

import { type ReactNode } from 'react';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

export function VeoHintProvider({ children }: { children: ReactNode }) {
  return <HintProvider page="veo">{children}</HintProvider>;
}