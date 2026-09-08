import { NextRequest } from 'next/server';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export function limitPublicExport(request: NextRequest, kind: 'markdown-export' | 'markdown-pdf' | 'marp-preview') {
  // These routes do not authenticate cookies. Use a shared per-process budget
  // so arbitrary cookie values cannot create unlimited renderer budgets.
  return rateLimit(new NextRequest(request.url), {
    limit: kind === 'markdown-pdf' ? 10 : 30,
    windowMs: 60_000,
    keyPrefix: `public-${kind}`,
  });
}
