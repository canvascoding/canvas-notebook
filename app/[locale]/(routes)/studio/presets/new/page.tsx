import { requirePageSession } from '@/app/lib/auth-guards';
import { PresetBuilder } from '@/app/apps/studio/components/presets/PresetBuilder';

export default async function StudioPresetNewPage() {
  await requirePageSession();

  return (
    <div className="p-4 md:p-6">
      <PresetBuilder />
    </div>
  );
}
