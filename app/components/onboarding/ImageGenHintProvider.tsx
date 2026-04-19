'use client';

import { type ReactNode } from 'react';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

export function ImageGenHintProvider({ children }: { children: ReactNode }) {
  return <HintProvider page="imageGen">{children}</HintProvider>;
}