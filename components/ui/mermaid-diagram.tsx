'use client';

import React, { useRef, useEffect, useState, useId } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
});

let mermaidRenderCounter = 0;

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uniqueId = useId();
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => {
      const root = document.documentElement;
      const dark = root.classList.contains('dark') || mq.matches;
      setIsDark(dark);
    };
    updateTheme();
    mq.addEventListener('change', updateTheme);
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mq.removeEventListener('change', updateTheme);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'strict',
        });

        const id = `mermaid-${uniqueId.replace(/:/g, '')}-${++mermaidRenderCounter}`;
        const { svg: renderedSvg } = await mermaid.render(id, code.trim());

        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg(null);
        }
      }
    };

    renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, isDark, uniqueId]);

  if (error) {
    return (
      <div className="mermaid-error my-3 rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30">
        <p className="mb-1 text-xs font-semibold text-red-600 dark:text-red-400">Mermaid Syntax Error</p>
        <pre className="overflow-x-auto text-xs text-red-700 dark:text-red-300">{code}</pre>
        <p className="mt-1 text-xs text-red-500 dark:text-red-400">{error}</p>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 flex min-h-12 items-center justify-center">
        <span className="text-xs text-muted-foreground">Rendering diagram…</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-diagram my-3 flex justify-center overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}