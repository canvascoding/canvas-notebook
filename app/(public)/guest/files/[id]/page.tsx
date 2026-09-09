import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FileGuestClient } from '@/app/components/file-guests/FileGuestClient';
import { isFileGuestId } from '@/app/lib/file-guests/types';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Geteilte Datei · Canvas Notebook', robots: { index: false, follow: false, nocache: true }, referrer: 'no-referrer' };

export default async function FileGuestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isFileGuestId(id)) notFound();
  return <FileGuestClient key={id} invitationId={id} />;
}
