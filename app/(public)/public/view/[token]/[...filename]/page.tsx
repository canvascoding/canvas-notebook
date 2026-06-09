import { notFound, redirect } from 'next/navigation';

import { PublicResolvedFilePreview, publicShortPreviewPath } from '@/app/(public)/public-preview-renderer';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';

export const dynamic = 'force-dynamic';

interface PublicFilePreviewPageProps {
  params: Promise<{
    token: string;
    filename: string[];
  }>;
}

export default async function PublicFilePreviewPage({ params }: PublicFilePreviewPageProps) {
  const { token } = await params;
  const decodedToken = decodeURIComponent(token);
  const resolved = await resolvePublicShareToken(decodedToken, { recordAccess: false });

  if (!resolved.ok) {
    notFound();
  }

  if (resolved.share.shortCode) {
    redirect(publicShortPreviewPath(resolved.share.shortCode));
  }

  return <PublicResolvedFilePreview resolved={resolved} />;
}
