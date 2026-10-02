'use client';

import { useEffect } from 'react';

import { useRouter } from '@/i18n/navigation';
import { useStudioBulkAvailability } from '../StudioBulkAvailabilityProvider';
import { BulkGenerateView } from './BulkGenerateView';

export function StudioBulkAvailabilityBoundary() {
  const router = useRouter();
  const { studioBulkEnabled, ready } = useStudioBulkAvailability();

  useEffect(() => {
    if (ready && !studioBulkEnabled) router.replace('/studio');
  }, [ready, router, studioBulkEnabled]);

  return ready && studioBulkEnabled ? <BulkGenerateView /> : null;
}
