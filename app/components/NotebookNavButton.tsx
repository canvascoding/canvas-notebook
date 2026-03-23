import { Link } from '@/i18n/navigation';
import { NotebookPen } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export function NotebookNavButton() {
  const t = useTranslations('navigation');
  return (
    <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
      <Link href="/notebook">
        <NotebookPen className="h-4 w-4" />
        <span className="hidden sm:inline">{t('notebook')}</span>
      </Link>
    </Button>
  );
}
