import { requirePageSession } from '@/app/lib/auth-guards';
import { ModelLibrary } from '@/app/apps/studio/components/models/ModelLibrary';

export default async function StudioModelsPage() {
  await requirePageSession();

  return (
    <div className="p-4 md:p-6">
      <ModelLibrary />
    </div>
  );
}
