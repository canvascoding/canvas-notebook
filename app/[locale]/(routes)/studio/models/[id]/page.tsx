import { requirePageSession } from '@/app/lib/auth-guards';
import { ModelDetailDialog } from '@/app/apps/studio/components/models/ModelDetailDialog';

interface StudioModelDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ type?: string }>;
}

export default async function StudioModelDetailPage({ params, searchParams }: StudioModelDetailPageProps) {
  await requirePageSession();
  const { id } = await params;
  const sp = await searchParams;
  const entityType = (sp.type === 'persona' ? 'persona' : sp.type === 'style' ? 'style' : 'product') as 'product' | 'persona' | 'style';

  return (
    <div className="p-4 md:p-6">
      <ModelDetailDialog entityId={id} entityType={entityType} />
    </div>
  );
}
