import { requirePageSession } from '@/app/lib/auth-guards';
import { StudioBulkAvailabilityBoundary } from '@/app/apps/studio/components/bulk/StudioBulkAvailabilityBoundary';

export default async function StudioBulkPage() {
  await requirePageSession();
  // proxy.ts guards direct requests; this boundary handles live policy changes.
  return (
    <div className="p-4 md:p-6">
      <StudioBulkAvailabilityBoundary />
    </div>
  );
}
