import { requirePageSession } from '@/app/lib/auth-guards';
import { BulkGenerateView } from '@/app/apps/studio/components/bulk/BulkGenerateView';

export default async function StudioBulkPage() {
  await requirePageSession();

  return (
    <div className="p-4 md:p-6">
      <BulkGenerateView />
    </div>
  );
}
