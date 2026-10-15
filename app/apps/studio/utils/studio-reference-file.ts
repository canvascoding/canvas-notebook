import { toMediaUrl } from '@/app/lib/utils/media-url';
import { studioApiFetch } from './studio-api';

export async function downloadStudioReferenceFile(reference: string): Promise<File> {
  const isWorkspaceReference = reference.startsWith('/api/media/');
  const response = isWorkspaceReference
    ? await fetch(reference, { credentials: 'include' })
    : await studioApiFetch(toMediaUrl(reference));
  if (!response.ok) throw new Error('Failed to download reference image');

  const blob = await response.blob();
  const fileName = isWorkspaceReference
    ? decodeURIComponent(new URL(reference, window.location.origin).pathname.split('/').pop() || 'image.jpg')
    : reference.split('/').pop() || 'image.jpg';
  return new File([blob], fileName, { type: blob.type || 'image/jpeg' });
}
