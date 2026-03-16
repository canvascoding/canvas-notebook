import Link from 'next/link';
import { NotebookPen } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function NotebookNavButton() {
  return (
    <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
      <Link href="/notebook">
        <NotebookPen className="h-4 w-4" />
        <span className="hidden sm:inline">Notebook</span>
      </Link>
    </Button>
  );
}
