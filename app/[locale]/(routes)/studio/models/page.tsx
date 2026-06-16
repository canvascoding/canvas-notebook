import { requirePageSession } from '@/app/lib/auth-guards';
import { ModelLibrary } from '@/app/apps/studio/components/models/ModelLibrary';

export default async function StudioModelsPage() {
  await requirePageSession();

  return (
    <div className="min-w-0 overflow-x-hidden px-3 py-4 sm:px-4 md:p-6">
      <ModelLibrary />
    </div>
  );
}
