import { requirePageSession } from '@/app/lib/auth-guards';
import { PresetBuilder } from '@/app/apps/studio/components/presets/PresetBuilder';

interface StudioPresetDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function StudioPresetDetailPage({ params }: StudioPresetDetailPageProps) {
  await requirePageSession();
  const { id } = await params;

  return (
    <div className="p-4 md:p-6">
      <PresetBuilder presetId={id} />
    </div>
  );
}
