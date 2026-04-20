import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { BulkGenerateView } from '@/app/apps/studio/components/bulk/BulkGenerateView';

export default async function StudioBulkPage() {
  await requirePageSession();

  return (
    <SuitePageLayout title="Studio">
      <BulkGenerateView />
    </SuitePageLayout>
  );
}