import type { NextRequest } from 'next/server';
import { handleDocumentCreateHttp } from '@/app/lib/documents/create-http';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) { return handleDocumentCreateHttp(request, 'import'); }
