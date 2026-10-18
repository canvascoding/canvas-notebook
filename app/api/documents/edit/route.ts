import type { NextRequest } from 'next/server';
import { handleDocumentEditHttp } from '@/app/lib/documents/edit-http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return handleDocumentEditHttp(request, 'edit');
}
