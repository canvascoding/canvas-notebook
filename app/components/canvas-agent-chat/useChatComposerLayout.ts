'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatInlineEditorHandle } from './ChatInlineEditor';

export function useChatComposerLayout({
  input: _input,
  isMobile: _isMobile,
}: {
  input: string;
  isMobile: boolean;
}) {
  const [composerHeight, setComposerHeight] = useState(220);
  const [composerWidth, setComposerWidth] = useState(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ChatInlineEditorHandle>(null);
  const composerMeasureRafRef = useRef<number | null>(null);

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

  return {
    composerHeight,
    composerRef,
    composerWidth,
    editorRef,
  };
}
