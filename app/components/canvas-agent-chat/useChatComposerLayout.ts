'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MOBILE_TEXTAREA_BASE_HEIGHT_PX = 56;
const DESKTOP_TEXTAREA_BASE_HEIGHT_PX = 72;
const MOBILE_TEXTAREA_MAX_HEIGHT_PX = 192;
const DESKTOP_TEXTAREA_MAX_HEIGHT_PX = 256;
const MOBILE_TEXTAREA_MAX_VIEWPORT_RATIO = 0.3;
const DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO = 0.35;

export function useChatComposerLayout({
  input,
  isMobile,
}: {
  input: string;
  isMobile: boolean;
}) {
  const [composerHeight, setComposerHeight] = useState(220);
  const [composerWidth, setComposerWidth] = useState(0);
  const [textareaHeight, setTextareaHeight] = useState(DESKTOP_TEXTAREA_BASE_HEIGHT_PX);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerMeasureRafRef = useRef<number | null>(null);

  const getTextareaBaseHeight = useCallback(() => (
    isMobile ? MOBILE_TEXTAREA_BASE_HEIGHT_PX : DESKTOP_TEXTAREA_BASE_HEIGHT_PX
  ), [isMobile]);

  const getTextareaMaxHeight = useCallback(() => {
    if (typeof window === 'undefined') {
      return isMobile ? MOBILE_TEXTAREA_MAX_HEIGHT_PX : DESKTOP_TEXTAREA_MAX_HEIGHT_PX;
    }

    const viewportLimit = Math.floor(
      window.innerHeight * (isMobile ? MOBILE_TEXTAREA_MAX_VIEWPORT_RATIO : DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO),
    );
    const fixedLimit = isMobile ? MOBILE_TEXTAREA_MAX_HEIGHT_PX : DESKTOP_TEXTAREA_MAX_HEIGHT_PX;
    return Math.max(getTextareaBaseHeight(), Math.min(fixedLimit, viewportLimit));
  }, [getTextareaBaseHeight, isMobile]);

  const syncTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const baseHeight = getTextareaBaseHeight();
    const maxHeight = getTextareaMaxHeight();
    textarea.style.height = 'auto';
    const nextHeight = Math.max(baseHeight, Math.min(Math.ceil(textarea.scrollHeight), maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    setTextareaHeight((current) => (current === nextHeight ? current : nextHeight));
  }, [getTextareaBaseHeight, getTextareaMaxHeight]);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [input, isMobile, syncTextareaHeight]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;

    const updateComposerSize = () => {
      composerMeasureRafRef.current = null;
      const { height, width } = composer.getBoundingClientRect();
      const nextHeight = Math.ceil(height);
      const nextWidth = Math.ceil(width);
      setComposerHeight((current) => (current === nextHeight ? current : nextHeight));
      setComposerWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    const scheduleComposerSizeUpdate = () => {
      if (composerMeasureRafRef.current !== null) {
        cancelAnimationFrame(composerMeasureRafRef.current);
      }
      composerMeasureRafRef.current = requestAnimationFrame(updateComposerSize);
    };

    updateComposerSize();

    const resizeObserver = new ResizeObserver(() => {
      scheduleComposerSizeUpdate();
    });

    resizeObserver.observe(composer);
    window.addEventListener('resize', scheduleComposerSizeUpdate);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleComposerSizeUpdate);
      if (composerMeasureRafRef.current !== null) {
        cancelAnimationFrame(composerMeasureRafRef.current);
        composerMeasureRafRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [composerWidth, syncTextareaHeight]);

  return {
    composerHeight,
    composerRef,
    composerWidth,
    textareaHeight,
    textareaRef,
  };
}
