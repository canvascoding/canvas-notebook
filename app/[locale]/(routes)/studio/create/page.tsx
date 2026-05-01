import { Suspense } from 'react';
import { requirePageSession } from '@/app/lib/auth-guards';
import { CreateView } from '@/app/apps/studio/components/create/CreateView';

export default async function StudioCreatePage() {
  await requirePageSession();

  return (
    <Suspense>
      <CreateView />
    </Suspense>
  );
}
