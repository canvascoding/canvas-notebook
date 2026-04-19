'use client';

import { Link } from '@/i18n/navigation';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function HelpNavButton() {
  return (
    <Button asChild variant="ghost" size="sm" className="gap-1.5 px-2" title="Help">
      <Link href="/help">
        <HelpCircle className="h-4 w-4" />
      </Link>
    </Button>
  );
}