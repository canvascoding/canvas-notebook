import { requirePageSession } from '@/app/lib/auth-guards';
import { FilesContainer } from '@/app/components/files/FilesContainer';

export const metadata = {
  title: 'Files - Canvas Notebook',
  description: 'Browse and manage workspace files',
};

export default async function FilesPage() {
  const session = await requirePageSession();
  void session;

  return <FilesContainer />;
}