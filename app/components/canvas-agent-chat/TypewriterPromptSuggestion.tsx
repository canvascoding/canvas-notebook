'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const TYPE_DELAY_MS = 34;
const DELETE_DELAY_MS = 18;
const COMPLETE_PAUSE_MS = 1_700;
const NEXT_PROMPT_PAUSE_MS = 280;

export function TypewriterPromptSuggestion({
  suggestions,
  className,
  testId,
}: {
  suggestions: readonly string[];
  className?: string;
  testId?: string;
}) {
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [visibleCharacterCount, setVisibleCharacterCount] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  const activeSuggestion = suggestions[suggestionIndex % Math.max(suggestions.length, 1)] ?? '';

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener('change', updatePreference);

    return () => mediaQuery.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    if (!activeSuggestion || prefersReducedMotion) return;

    const hasFinishedTyping = visibleCharacterCount >= activeSuggestion.length;
    const hasFinishedDeleting = visibleCharacterCount === 0;
    const delay = isDeleting
      ? hasFinishedDeleting ? NEXT_PROMPT_PAUSE_MS : DELETE_DELAY_MS
      : hasFinishedTyping ? COMPLETE_PAUSE_MS : TYPE_DELAY_MS;

    const timeoutId = window.setTimeout(() => {
      if (isDeleting) {
        if (hasFinishedDeleting) {
          setIsDeleting(false);
          setSuggestionIndex((current) => (current + 1) % suggestions.length);
          return;
        }
        setVisibleCharacterCount((current) => Math.max(0, current - 1));
        return;
      }

      if (hasFinishedTyping) {
        setIsDeleting(true);
        return;
      }

      setVisibleCharacterCount((current) => Math.min(activeSuggestion.length, current + 1));
    }, delay);

    return () => window.clearTimeout(timeoutId);
  }, [
    activeSuggestion,
    isDeleting,
    prefersReducedMotion,
    suggestions.length,
    visibleCharacterCount,
  ]);

  if (!activeSuggestion) return null;

  const text = prefersReducedMotion
    ? activeSuggestion
    : activeSuggestion.slice(0, visibleCharacterCount);

  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className={cn('pointer-events-none absolute text-muted-foreground', className)}
    >
      <span>{text}</span>
      <span className="ml-0.5 inline-block h-[1.05em] w-px translate-y-[0.18em] bg-current motion-safe:animate-pulse" />
    </div>
  );
}
