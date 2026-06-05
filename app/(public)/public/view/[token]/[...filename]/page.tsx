import { promises as fs } from 'node:fs';

import { notFound } from 'next/navigation';

import { PublicExcalidrawViewer } from '@/app/components/public-sharing/PublicExcalidrawViewer';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';

export const dynamic = 'force-dynamic';

interface PublicExcalidrawPreviewPageProps {
  params: Promise<{
    token: string;
    filename: string[];
  }>;
}

export default async function PublicExcalidrawPreviewPage({ params }: PublicExcalidrawPreviewPageProps) {
  const { token } = await params;
  const resolved = await resolvePublicShareToken(decodeURIComponent(token));

  if (!resolved.ok || !isExcalidrawFilePath(resolved.workspacePath)) {
    notFound();
  }

  let content: string;
  try {
    content = await fs.readFile(resolved.fullPath, 'utf8');
  } catch {
    notFound();
  }

  return (
    <PublicExcalidrawViewer
      fileName={resolved.share.fileName}
      content={content}
    />
  );
}
