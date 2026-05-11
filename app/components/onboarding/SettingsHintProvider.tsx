'use client';

import { type ReactNode } from 'react';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

export function SettingsHintProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  return <HintProvider page="settings" enabled={enabled}>{children}</HintProvider>;
}