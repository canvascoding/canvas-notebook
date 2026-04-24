import { requirePageSession } from '@/app/lib/auth-guards';
import { PresetLibrary } from '@/app/apps/studio/components/presets/PresetLibrary';

export default async function StudioPresetsPage() {
  await requirePageSession();

  return (
    <div className="p-4 md:p-6">
      <PresetLibrary />
    </div>
  );
}
