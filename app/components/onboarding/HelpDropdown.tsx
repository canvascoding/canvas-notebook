'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { HelpCircle, RotateCcw, Check, BookOpen, Loader2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { useHintContext } from './HintProvider';
import { useHintSequence, type HintState } from './useHintSequence';
import { ONBOARDING_PAGES } from './hint-config';

interface HelpDropdownProps {
  page?: string;
}

type HelpDropdownMenuProps = {
  page: string;
  state: HintState | null;
  loading: boolean;
  completePage: () => Promise<unknown>;
  resetPage: () => Promise<unknown>;
};

function HelpDropdownMenu({
  page,
  state,
  loading,
  completePage,
  resetPage,
}: HelpDropdownMenuProps) {
  const t = useTranslations('onboarding.helpDropdown');
  const [open, setOpen] = useState(false);
  const [actionPending, setActionPending] = useState<'repeat' | 'complete' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasHintsForPage = Boolean(page && ONBOARDING_PAGES[page]);
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
    if (!page || actionPending) return;
    setActionPending('repeat');
    setActionError(null);
    try {
      const result = await resetPage();
      if (!result) {
        setActionError(t('actionError'));
        return;
      }
      setOpen(false);
    } finally {
      setActionPending(null);
    }
  };

  const handleCompleteOnboarding = async () => {
    if (!page || actionPending) return;
    setActionPending('complete');
    setActionError(null);
    try {
      const result = await completePage();
      if (!result) {
        setActionError(t('actionError'));
        return;
      }
      setOpen(false);
    } finally {
      setActionPending(null);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 px-2"
        onClick={() => {
          setActionError(null);
          setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('label')}
        title={t('label')}
      >
        <HelpCircle className="h-4 w-4" />
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-lg border border-border bg-popover p-1 shadow-md">
          {hasHintsForPage && (
            <button
              type="button"
              onClick={() => void handleRepeatTutorial()}
              disabled={loading || actionPending !== null}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
            >
              {actionPending === 'repeat'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RotateCcw className="h-4 w-4" />}
              {t('repeatTutorial')}
            </button>
          )}

          {hasHintsForPage && !isCompleted && (
            <button
              type="button"
              onClick={() => void handleCompleteOnboarding()}
              disabled={loading || actionPending !== null}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
            >
              {actionPending === 'complete'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Check className="h-4 w-4" />}
              {t('completeOnboarding')}
            </button>
          )}

          {actionError && (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {actionError}
            </p>
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

function StandaloneHelpDropdown({ page }: { page: string }) {
  const sequence = useHintSequence(page);
  return (
    <HelpDropdownMenu
      page={page}
      state={sequence.state}
      loading={sequence.loading}
      completePage={sequence.completePage}
      resetPage={sequence.resetPage}
    />
  );
}

export function HelpDropdown({ page }: HelpDropdownProps) {
  const hintContext = useHintContext();
  const effectivePage = page || hintContext.page;
  const usesProvider = Boolean(effectivePage && hintContext.page === effectivePage);

  if (usesProvider) {
    return (
      <HelpDropdownMenu
        page={effectivePage}
        state={hintContext.state}
        loading={hintContext.loading}
        completePage={hintContext.completePage}
        resetPage={hintContext.resetPage}
      />
    );
  }

  if (!effectivePage) {
    return (
      <HelpDropdownMenu
        page=""
        state={null}
        loading={false}
        completePage={async () => null}
        resetPage={async () => null}
      />
    );
  }

  return <StandaloneHelpDropdown page={effectivePage} />;
}
