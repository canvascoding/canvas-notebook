'use client';

import { type ReactNode } from 'react';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

export function SettingsHintProvider({ children }: { children: ReactNode }) {
  return <HintProvider page="settings">{children}</HintProvider>;
}