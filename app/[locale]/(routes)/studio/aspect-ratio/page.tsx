import { requirePageSession } from '@/app/lib/auth-guards';
import { AspectRatioEditorView } from '@/app/apps/studio/components/aspect-ratio/AspectRatioEditorView';

export default async function StudioAspectRatioPage() {
  await requirePageSession();

  return <AspectRatioEditorView />;
}
