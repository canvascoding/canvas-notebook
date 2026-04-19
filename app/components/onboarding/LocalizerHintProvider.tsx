'use client';

import { type ReactNode } from 'react';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

export function LocalizerHintProvider({ children }: { children: ReactNode }) {
  return <HintProvider page="localizer">{children}</HintProvider>;
}