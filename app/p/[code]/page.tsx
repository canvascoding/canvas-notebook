import { notFound } from 'next/navigation';

import { PublicResolvedFilePreview } from '@/app/(public)/public-preview-renderer';
import { resolvePublicShareShortCode } from '@/app/lib/public-sharing/public-file-shares';

export const dynamic = 'force-dynamic';

interface ShortPublicFilePreviewPageProps {
  params: Promise<{
    code: string;
  }>;
}

export default async function ShortPublicFilePreviewPage({ params }: ShortPublicFilePreviewPageProps) {
  const { code } = await params;
  const resolved = await resolvePublicShareShortCode(decodeURIComponent(code));

  if (!resolved.ok) {
    notFound();
  }

  return <PublicResolvedFilePreview resolved={resolved} />;
}
