'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { HelpCircle, RotateCcw, Check, BookOpen } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { useHintSequence } from './useHintSequence';
import { ONBOARDING_PAGES } from './hint-config';

interface HelpDropdownProps {
  page?: string;
}

export function HelpDropdown({ page }: HelpDropdownProps) {
  const t = useTranslations('onboarding.helpDropdown');
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasHintsForPage = page ? !!ONBOARDING_PAGES[page] : false;
  const { state, completePage, resetPage } = useHintSequence(page ?? '');
  const isCompleted = state?.completed ?? false;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const handleRepeatTutorial = async () => {
    setOpen(false);
    if (page) {
      await resetPage();
    }
  };

  const handleCompleteOnboarding = async () => {
    setOpen(false);
    if (page) {
      await completePage();
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 px-2"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Help"
      >
        <HelpCircle className="h-4 w-4" />
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-lg border border-border bg-popover p-1 shadow-md">
          {hasHintsForPage && (
            <button
              type="button"
              onClick={handleRepeatTutorial}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              {t('repeatTutorial')}
            </button>
          )}

          {hasHintsForPage && !isCompleted && (
            <button
              type="button"
              onClick={handleCompleteOnboarding}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
            >
              <Check className="h-4 w-4" />
              {t('completeOnboarding')}
            </button>
          )}

          <Link
            href="/help"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
          >
            <BookOpen className="h-4 w-4" />
            {t('openHelp')}
          </Link>
        </div>
      )}
    </div>
  );
}