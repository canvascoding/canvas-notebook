import { requirePageSession } from '@/app/lib/auth-guards';
import { ModelCreateDialog } from '@/app/apps/studio/components/models/ModelCreateDialog';

export default async function StudioModelNewPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  await requirePageSession();
  const params = await searchParams;
  const entityType = params.type === 'persona' ? 'persona' : params.type === 'style' ? 'style' : 'product';

  return (
    <div className="p-4 md:p-6">
      <ModelCreateDialog entityType={entityType} />
    </div>
  );
}
